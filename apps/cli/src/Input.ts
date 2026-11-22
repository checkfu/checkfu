import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import { type CliFailure, usageError } from "./Errors.ts"

const MAX_STDIN_BYTES = 2 * 1024 * 1024

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const resolveTextOrFile = (
	raw: string,
): Effect.Effect<string, CliFailure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (raw.startsWith("@@")) return raw.slice(1)
		if (raw.startsWith("@") && raw.length > 1) {
			const filePath = raw.slice(1)
			const fs = yield* FileSystem.FileSystem
			return yield* fs
				.readFileString(filePath)
				.pipe(
					Effect.mapError((err) => usageError(`Failed to read file "${filePath}": ${err.message}`)),
				)
		}
		return raw
	})

export const parseJsonOrYaml = (raw: string, label: string): Effect.Effect<unknown, CliFailure> =>
	Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: () => undefined,
	}).pipe(
		Effect.catch(() =>
			Effect.try({
				try: () => YAML.parse(raw) as unknown,
				catch: (err) =>
					usageError(
						`Invalid JSON or YAML for ${label}: ${err instanceof Error ? err.message : String(err)}`,
					),
			}),
		),
	)

export const resolveStructuredInput = (
	raw: string,
	label: string,
): Effect.Effect<unknown, CliFailure, FileSystem.FileSystem> =>
	resolveTextOrFile(raw).pipe(Effect.flatMap((text) => parseJsonOrYaml(text, label)))

export const readPipedStdin = (): Effect.Effect<Option.Option<unknown>, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		if (yield* stdio.stdinIsTerminal) {
			return Option.none()
		}
		const chunks: Array<Uint8Array> = []
		let totalBytes = 0
		yield* stdio.stdin.pipe(
			Stream.mapError((err) => usageError(`Failed to read stdin: ${err.message}`)),
			Stream.runForEach((chunk) =>
				Effect.suspend(() => {
					totalBytes += chunk.byteLength
					if (totalBytes > MAX_STDIN_BYTES) {
						return Effect.fail(usageError(`stdin payload exceeds ${MAX_STDIN_BYTES} byte limit.`))
					}
					chunks.push(chunk)
					return Effect.void
				}),
			),
		)
		if (totalBytes === 0) return Option.none()
		const merged = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			merged.set(chunk, offset)
			offset += chunk.byteLength
		}
		const text = new TextDecoder().decode(merged)
		if (text.trim().length === 0) return Option.none()
		const parsed = yield* parseJsonOrYaml(text, "stdin")
		return Option.some(parsed)
	})

export const readPipedStdinRecord = (
	label: string,
): Effect.Effect<Record<string, unknown>, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const input = yield* readPipedStdin()
		if (Option.isNone(input)) return {}
		if (!isPlainRecord(input.value)) {
			return yield* usageError(`Expected a JSON or YAML object on stdin for ${label}.`)
		}
		return input.value
	})

export const decodePayload = <S extends Schema.Codec<unknown, unknown, never, unknown>>(
	schema: S,
	raw: unknown,
	label: string,
): Effect.Effect<S["Type"], CliFailure> =>
	Schema.decodeUnknownEffect(schema)(raw).pipe(
		Effect.mapError((err) => usageError(`Invalid ${label}: ${err.message}`)),
	)
