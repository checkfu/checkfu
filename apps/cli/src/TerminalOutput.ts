import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { CliFailure } from "./Errors.ts"

const isBidiOrSeparatorCodePoint = (code: number): boolean =>
	code === 0x061c ||
	code === 0x200e ||
	code === 0x200f ||
	code === 0x2028 ||
	code === 0x2029 ||
	(code >= 0x202a && code <= 0x202e) ||
	(code >= 0x2066 && code <= 0x2069)

const isUnsafeHumanCodePoint = (code: number): boolean =>
	(code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
	(code >= 0x7f && code <= 0x9f) ||
	isBidiOrSeparatorCodePoint(code)

const isUnsafeJsonTerminalCodePoint = (code: number): boolean =>
	(code >= 0x7f && code <= 0x9f) || isBidiOrSeparatorCodePoint(code)

const formatHexEscape = (code: number): string =>
	code <= 0xff
		? `\\x${code.toString(16).padStart(2, "0")}`
		: `\\u${code.toString(16).padStart(4, "0")}`

export const hasUnsafeTerminalCodePoint = (value: string): boolean => {
	for (let i = 0; i < value.length; i++) {
		if (isUnsafeHumanCodePoint(value.charCodeAt(i))) {
			return true
		}
	}
	return false
}

export const escapeQuotedTerminalCodePoints = (value: string): string => {
	let out = ""
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (isUnsafeHumanCodePoint(code)) {
			out += `\\u${code.toString(16).padStart(4, "0")}`
		} else {
			out += value[i] ?? ""
		}
	}
	return out
}

export const escapeTerminalControlCharacters = (value: string): string => {
	const normalized = value.replaceAll("\r\n", "\n")
	let out = ""
	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i)
		if (isUnsafeHumanCodePoint(code)) {
			out += formatHexEscape(code)
		} else {
			out += normalized[i] ?? ""
		}
	}
	return out
}

export const stringifyTerminalSafeJson = (value: unknown, space?: number): string => {
	const json = JSON.stringify(value, null, space) ?? "null"
	let out = ""
	for (let i = 0; i < json.length; i++) {
		const code = json.charCodeAt(i)
		if (isUnsafeJsonTerminalCodePoint(code)) {
			out += `\\u${code.toString(16).padStart(4, "0")}`
		} else {
			out += json[i] ?? ""
		}
	}
	return out
}

export const writeStdout = (text: string): Effect.Effect<void, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		yield* Stream.make(text).pipe(
			Stream.run(stdio.stdout({ endOnDone: false })),
			Effect.mapError((err) => new CliFailure({ message: err.message, exitCode: 1 })),
		)
	})

export const writeStderr = (text: string): Effect.Effect<void, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		yield* Stream.make(text).pipe(
			Stream.run(stdio.stderr({ endOnDone: false })),
			Effect.mapError((err) => new CliFailure({ message: err.message, exitCode: 1 })),
		)
	})

export const writeStdoutLine = (line: string): Effect.Effect<void, CliFailure, Stdio.Stdio> =>
	writeStdout(`${line}\n`)

export const writeStderrLine = (line: string): Effect.Effect<void, CliFailure, Stdio.Stdio> =>
	writeStderr(`${escapeTerminalControlCharacters(line)}\n`)
