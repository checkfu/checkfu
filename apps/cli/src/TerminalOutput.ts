import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { CliFailure } from "./Errors.ts"

const UNSAFE_FOR_HUMANS = /(?![\t\n])[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu
const UNSAFE_IN_JSON = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g

const unicodeEscape = (character: string): string =>
	`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`

const hexEscape = (character: string): string => {
	const code = character.charCodeAt(0)
	return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : unicodeEscape(character)
}

export const hasUnsafeTerminalCodePoint = (value: string): boolean =>
	value.search(UNSAFE_FOR_HUMANS) !== -1

export const escapeQuotedTerminalCodePoints = (value: string): string =>
	value.replaceAll(UNSAFE_FOR_HUMANS, unicodeEscape)

export const escapeTerminalControlCharacters = (value: string): string =>
	value.replaceAll("\r\n", "\n").replaceAll(UNSAFE_FOR_HUMANS, hexEscape)

export const stringifyTerminalSafeJson = (value: unknown, space?: number): string =>
	(JSON.stringify(value, null, space) ?? "null").replaceAll(UNSAFE_IN_JSON, unicodeEscape)

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
