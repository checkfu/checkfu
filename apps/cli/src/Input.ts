import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { visit } from "jsonc-parser/lib/esm/main.js"
import * as YAML from "yaml"
import { usageError } from "./Errors.ts"
import type { CliFailure } from "./Errors.ts"
import { writeStderrLine } from "./TerminalOutput.ts"

export const MAX_INPUT_BYTES = 2 * 1024 * 1024

export interface InputBudget {
	readonly limit: number
	used: number
}

export type InputLimit = number | InputBudget

export const inputBudget = (limit: number): InputBudget => ({ limit, used: 0 })

const budgetOf = (limit: InputLimit = MAX_INPUT_BYTES): InputBudget =>
	typeof limit === "number" ? inputBudget(limit) : limit

const tooLarge = (label: string, budget: InputBudget) =>
	usageError(
		budget.used > 0
			? `${label} exceeds ${budget.limit} byte limit together with the other inputs.`
			: `${label} exceeds ${budget.limit} byte limit.`,
	)

export type StructuredValue = Schema.Json
export type StructuredRecord = Record<string, StructuredValue>

export const isPlainRecord = (value: unknown): value is StructuredRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readBoundedBytes = <E extends { readonly message: string }>(
	stream: Stream.Stream<Uint8Array, E>,
	budget: InputBudget,
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
					if (budget.used + totalBytes > budget.limit) {
						return Effect.fail(tooLarge(limitLabel, budget))
					}
					chunks.push(chunk)
					return Effect.void
				}),
			),
		)
		budget.used += totalBytes
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
	limit?: InputLimit,
): Effect.Effect<string, CliFailure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (raw.startsWith("@@")) {
			return raw.slice(1)
		}
		if (raw.startsWith("@") && raw.length > 1) {
			const filePath = raw.slice(1)
			const label = `File "${filePath}"`
			const readError = `Failed to read file "${filePath}"`
			const budget = budgetOf(limit)
			const fs = yield* FileSystem.FileSystem
			const info = yield* fs
				.stat(filePath)
				.pipe(Effect.mapError((err) => usageError(`${readError}: ${err.message}`)))
			if (budget.used + Number(info.size) > budget.limit) {
				return yield* tooLarge(label, budget)
			}
			const bytes = yield* readBoundedBytes(fs.stream(filePath), budget, readError, label)
			return yield* decodeUtf8Strict(bytes, label)
		}
		return raw
	})

export interface ParsedStructuredInput {
	readonly value: StructuredValue
	readonly warnings: ReadonlyArray<string>
}

const isJsonValue = Schema.is(Schema.Json)

const requireJsonValue = (value: unknown): StructuredValue => {
	if (!isJsonValue(value)) {
		throw new Error("Expected JSON values. Quote date-like values and use finite numbers.")
	}
	return value
}

const rejectDuplicateJsonMembers = (raw: string): void => {
	const keys: Array<Set<string>> = []
	visit(raw, {
		onObjectBegin: () => {
			keys.push(new Set())
		},
		onObjectProperty: (key, _offset, _length, line, column) => {
			const scope = keys.at(-1)
			if (scope?.has(key) === true) {
				throw new Error(`Duplicate object member at line ${line + 1}, column ${column + 1}.`)
			}
			scope?.add(key)
		},
		onObjectEnd: () => {
			keys.pop()
		},
	})
}

const parseYamlDocument = (raw: string): ParsedStructuredInput => {
	const doc = YAML.parseDocument(raw, { logLevel: "error", prettyErrors: false, merge: false })
	const error =
		doc.errors[0] ?? doc.warnings.find((warning) => warning.code === "TAG_RESOLVE_FAILED")
	if (error?.code === "MULTIPLE_DOCS") {
		throw new Error("Input contains multiple documents. Send one document.")
	}
	if (error !== undefined) {
		throw new Error(`Invalid YAML (${error.code}) at character ${error.pos[0] + 1}.`)
	}
	YAML.visit(doc, {
		Pair: (_index, pair) => {
			if (!YAML.isScalar(pair.key) || typeof pair.key.value !== "string") {
				throw new Error("Mapping keys must be strings. Quote a literal key.")
			}
		},
	})
	return {
		value: requireJsonValue(doc.toJS({ maxAliasCount: 100 })),
		warnings: doc.warnings.map((warning) => warning.message),
	}
}

export const parseJsonOrYamlDocument = (
	raw: string,
	label: string,
): Effect.Effect<ParsedStructuredInput, CliFailure> =>
	Effect.try({
		try: () => {
			let parsed: unknown
			try {
				parsed = JSON.parse(raw)
			} catch {
				return parseYamlDocument(raw)
			}
			rejectDuplicateJsonMembers(raw)
			return { value: requireJsonValue(parsed), warnings: [] }
		},
		catch: (error) => {
			const message =
				error instanceof Error && error.name === "Error"
					? error.message
					: "Expected a JSON-compatible document within the parser limits."
			return usageError(`Invalid JSON or YAML for ${label}: ${message}`)
		},
	})

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
	limit?: InputLimit,
): Effect.Effect<StructuredValue, CliFailure, FileSystem.FileSystem | Stdio.Stdio> =>
	resolveTextOrFile(raw, limit).pipe(Effect.flatMap((text) => parseJsonOrYaml(text, label)))

export const readPipedStdin = (
	limit?: InputLimit,
): Effect.Effect<Option.Option<StructuredValue>, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		if (yield* stdio.stdinIsTerminal) {
			return Option.none()
		}
		const bytes = yield* readBoundedBytes(
			stdio.stdin,
			budgetOf(limit),
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
	limit?: InputLimit,
): Effect.Effect<StructuredRecord, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const input = yield* readPipedStdin(limit)
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
