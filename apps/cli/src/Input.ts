import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as YAML from "yaml"
import { usageError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { writeStderrLine } from "./TerminalOutput.ts"
import { normalizeJsonValue } from "./Transform.ts"
import type { NormalizedValue } from "./Transform.ts"

export const MAX_INPUT_BYTES = 2 * 1024 * 1024

export type StructuredValue = NormalizedValue
export type StructuredRecord = Record<string, StructuredValue>

export const isPlainRecord = (value: unknown): value is StructuredRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readBoundedBytes = <E extends { readonly message: string }>(
	stream: Stream.Stream<Uint8Array, E>,
	maxBytes: number,
	readErrorPrefix: string,
	limitLabel: string,
): Effect.Effect<Uint8Array, CliFailure> =>
	Effect.gen(function* () {
		const chunks: Array<Uint8Array> = []
		let totalBytes = 0
		yield* stream.pipe(
			Stream.mapError((err) => usageError(`${readErrorPrefix}: ${err.message}`)),
			Stream.runForEach((chunk) =>
				Effect.suspend(() => {
					totalBytes += chunk.byteLength
					if (totalBytes > maxBytes) {
						return Effect.fail(usageError(`${limitLabel} exceeds ${maxBytes} byte limit.`))
					}
					chunks.push(chunk)
					return Effect.void
				}),
			),
		)
		const merged = new Uint8Array(totalBytes)
		let offset = 0
		for (const chunk of chunks) {
			merged.set(chunk, offset)
			offset += chunk.byteLength
		}
		return merged
	})

const decodeUtf8Strict = (
	bytes: Uint8Array,
	sourceLabel: string,
): Effect.Effect<string, CliFailure> =>
	Effect.try({
		try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		catch: () => usageError(`${sourceLabel} is not valid UTF-8.`),
	})

export const resolveTextOrFile = (
	raw: string,
): Effect.Effect<string, CliFailure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (raw.startsWith("@@")) {
			return raw.slice(1)
		}
		if (raw.startsWith("@") && raw.length > 1) {
			const filePath = raw.slice(1)
			const fs = yield* FileSystem.FileSystem
			const bytes = yield* readBoundedBytes(
				fs.stream(filePath),
				MAX_INPUT_BYTES,
				`Failed to read file "${filePath}"`,
				`File "${filePath}"`,
			)
			return yield* decodeUtf8Strict(bytes, `File "${filePath}"`)
		}
		return raw
	})

export interface ParsedStructuredInput {
	readonly value: StructuredValue
	readonly warnings: ReadonlyArray<string>
}

export const parseJsonOrYamlDocument = (
	raw: string,
	label: string,
): Effect.Effect<ParsedStructuredInput, CliFailure> =>
	Effect.try({
		try: () => ({
			value: normalizeJsonValue(JSON.parse(raw)),
			warnings: [] as ReadonlyArray<string>,
		}),
		catch: () => undefined,
	}).pipe(
		Effect.catch(() =>
			Effect.try({
				try: () => {
					const doc = YAML.parseDocument(raw, { logLevel: "silent" })
					if (doc.errors.length > 0) {
						throw new Error(doc.errors[0]?.message ?? "Invalid YAML document.")
					}
					return {
						value: normalizeJsonValue(doc.toJS()),
						warnings: doc.warnings.map((warning) => warning.message),
					}
				},
				catch: (err) =>
					usageError(
						`Invalid JSON or YAML for ${label}: ${err instanceof Error ? err.message : String(err)}`,
					),
			}),
		),
	)

export const emitYamlWarnings = (
	label: string,
	warnings: ReadonlyArray<string>,
): Effect.Effect<void, CliFailure, Stdio.Stdio> =>
	Effect.forEach(warnings, (warning) => writeStderrLine(`Warning (${label}): ${warning}`), {
		discard: true,
	})

export const parseJsonOrYaml = (
	raw: string,
	label: string,
): Effect.Effect<StructuredValue, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const parsed = yield* parseJsonOrYamlDocument(raw, label)
		yield* emitYamlWarnings(label, parsed.warnings)
		return parsed.value
	})

export const resolveStructuredInput = (
	raw: string,
	label: string,
): Effect.Effect<StructuredValue, CliFailure, FileSystem.FileSystem | Stdio.Stdio> =>
	resolveTextOrFile(raw).pipe(Effect.flatMap((text) => parseJsonOrYaml(text, label)))

export const readPipedStdin: Effect.Effect<
	Option.Option<StructuredValue>,
	CliFailure,
	Stdio.Stdio
> = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	if (yield* stdio.stdinIsTerminal) {
		return Option.none()
	}
	const bytes = yield* readBoundedBytes(
		stdio.stdin,
		MAX_INPUT_BYTES,
		"Failed to read stdin",
		"stdin payload",
	)
	if (bytes.byteLength === 0) {
		return Option.none()
	}
	const text = yield* decodeUtf8Strict(bytes, "stdin")
	if (text.trim().length === 0) {
		return Option.none()
	}
	const parsed = yield* parseJsonOrYaml(text, "stdin")
	return Option.some(parsed)
})

export const readPipedStdinRecord = (
	label: string,
): Effect.Effect<StructuredRecord, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const input = yield* readPipedStdin
		if (Option.isNone(input)) {
			return {}
		}
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
