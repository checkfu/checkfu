import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

// grep and read as the library declares them, run here where the library cannot bound them: grep
// collects a whole page of matches before anything measures it, and read refuses a line longer
// than one page.

interface GrepContextLine {
	readonly line: number
	readonly text: string
	readonly isMatch: boolean
}

interface GrepMatch {
	readonly path: string
	readonly line: number
	readonly text: string
	readonly context?: ReadonlyArray<GrepContextLine>
}

export interface PagingFiles {
	readonly grep: (
		pattern: string,
		path: string,
		options: {
			readonly regex: boolean
			readonly ignoreCase: boolean
			readonly context: number
			readonly limit: number
			readonly offset: number
			readonly include?: string
			readonly exclude?: Array<string>
		},
	) => Promise<ReadonlyArray<GrepMatch>>
	readonly stat: (path: string) => Promise<{ readonly size: number }>
	readonly readFile: (
		path: string,
		options: { readonly byteOffset: number; readonly byteLength: number },
	) => Promise<ReadableStream<Uint8Array>>
}

const Count = (minimum: number, maximum: number) =>
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const Globs = Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)]))

const GrepArguments = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	query: Schema.String,
	include: Globs,
	exclude: Globs,
	regex: Schema.optionalKey(Schema.Boolean),
	ignoreCase: Schema.optionalKey(Schema.Boolean),
	context: Schema.optionalKey(Count(0, 10)),
	limit: Schema.optionalKey(Count(1, 1000)),
	offset: Schema.optionalKey(Count(0, Number.MAX_SAFE_INTEGER)),
})

const ReadArguments = Schema.Struct({
	path: Schema.String,
	offset: Schema.optionalKey(Count(1, Number.MAX_SAFE_INTEGER)),
	byteOffset: Schema.optionalKey(Count(0, Number.MAX_SAFE_INTEGER)),
})

const json = (value: unknown, isError = false): WorkspaceToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	isError,
})

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

const GREP_PAGE = 200
const EARLY_END_NOTE =
	"This page ended early to fit what one call returns; go on from nextOffset, or ask with fewer context lines."
const GREP_BATCH = 20
// Long enough to show a match in its line; a minified file's line is cut here.
const GREP_LINE_CHARACTERS = 500

const clip = (text: string): string =>
	text.length <= GREP_LINE_CHARACTERS
		? text
		: `${text.slice(0, GREP_LINE_CHARACTERS)} [${text.length - GREP_LINE_CHARACTERS} more characters]`

const globList = (value: string | ReadonlyArray<string> | undefined): Array<string> | undefined => {
	const list = (typeof value === "string" ? [value] : (value ?? [])).filter(
		(glob) => glob.trim() !== "",
	)
	return list.length === 0 ? undefined : list
}

/**
 * A page of matches, collected a batch at a time and measured as it grows, each line cut to a
 * readable length. A page that reaches `maxBytes` ends early with the offset to go on from.
 */
export const grepWithin = async (
	files: PagingFiles,
	input: unknown,
	maxBytes: number,
): Promise<WorkspaceToolResult> => {
	const decoded = Schema.decodeUnknownOption(GrepArguments)(input)
	if (Option.isNone(decoded)) {
		return json(
			{
				error:
					"grep takes `query` and optionally path, include, exclude, regex, ignoreCase, context (0-10), limit (1-1000) and offset.",
			},
			true,
		)
	}
	const args = decoded.value
	const path = args.path ?? "/workspace"
	const pageSize = args.limit ?? GREP_PAGE
	const start = args.offset ?? 0
	const includes = globList(args.include)
	const exclude = globList(args.exclude)
	const include =
		includes === undefined
			? undefined
			: includes.length === 1
				? includes[0]
				: `{${includes.join(",")}}`
	const matches: Array<GrepMatch> = []
	// What the page costs before its matches: its own fields, the next offset and the note a page
	// that ends early carries.
	let bytes = byteLength(
		JSON.stringify({
			path,
			query: args.query,
			count: pageSize,
			matches: [],
			nextOffset: start + pageSize,
			note: EARLY_END_NOTE,
		}),
	)
	let more = false
	let full = false
	while (!more && !full) {
		const wanted = Math.min(GREP_BATCH, pageSize + 1 - matches.length)
		let batch: ReadonlyArray<GrepMatch>
		try {
			batch = await files.grep(args.query, path, {
				regex: args.regex ?? false,
				ignoreCase: args.ignoreCase ?? false,
				context: args.context ?? 0,
				limit: wanted,
				offset: start + matches.length,
				...(include === undefined ? {} : { include }),
				...(exclude === undefined ? {} : { exclude }),
			})
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, true)
		}
		for (const found of batch) {
			if (matches.length === pageSize) {
				more = true
				break
			}
			const match: GrepMatch = {
				path: found.path,
				line: found.line,
				text: clip(found.text),
				...(found.context === undefined
					? {}
					: { context: found.context.map((line) => ({ ...line, text: clip(line.text) })) }),
			}
			const cost = byteLength(JSON.stringify(match)) + 1
			if (bytes + cost > maxBytes) {
				full = true
				break
			}
			matches.push(match)
			bytes += cost
		}
		if (batch.length < wanted) {
			break
		}
	}
	return json({
		path,
		query: args.query,
		count: matches.length,
		matches,
		...(more || full ? { nextOffset: start + matches.length } : {}),
		...(full
			? {
					note: EARLY_END_NOTE,
				}
			: {}),
	})
}

const readBytes = async (
	files: PagingFiles,
	path: string,
	byteOffset: number,
	length: number,
): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			await files.readFile(path, { byteOffset, byteLength: length }),
		).arrayBuffer(),
	)

const SCAN_BYTES = 64 * 1024
const NEWLINE = 10

// Where a line starts: line 1 at 0, a later one just after the newline before it.
const lineStart = async (
	files: PagingFiles,
	path: string,
	line: number,
	size: number,
): Promise<number | undefined> => {
	let seen = 1
	for (let position = 0; seen < line && position < size; position += SCAN_BYTES) {
		const chunk = await readBytes(files, path, position, SCAN_BYTES)
		for (
			let index = chunk.indexOf(NEWLINE);
			index !== -1;
			index = chunk.indexOf(NEWLINE, index + 1)
		) {
			seen += 1
			if (seen === line) {
				return position + index + 1
			}
		}
		if (chunk.byteLength === 0) {
			break
		}
	}
	return seen === line ? 0 : undefined
}

// The UTF-8 bytes from the start up to `end`, moved back so no character is split.
const characterEnd = (bytes: Uint8Array, end: number): number => {
	let at = end
	while (at > 0 && at < bytes.byteLength && ((bytes[at] ?? 0) & 0b1100_0000) === 0b1000_0000) {
		at -= 1
	}
	return at
}

/**
 * The library refuses a line longer than one page. When the line a read asks for is one, this
 * returns a page of its bytes and the byte offset to read on from; otherwise undefined.
 */
export const readLongLine = async (
	files: PagingFiles,
	input: unknown,
	pageBytes: number,
): Promise<WorkspaceToolResult | undefined> => {
	const decoded = Schema.decodeUnknownOption(ReadArguments)(input)
	if (Option.isNone(decoded)) {
		return undefined
	}
	const { path, offset = 1, byteOffset } = decoded.value
	const { size } = await files.stat(path)
	const start = byteOffset ?? (await lineStart(files, path, offset, size))
	if (start === undefined || start >= size) {
		return undefined
	}
	const bytes = await readBytes(files, path, start, pageBytes + 1)
	const newline = bytes.indexOf(NEWLINE)
	if (bytes.byteLength <= pageBytes || (newline !== -1 && newline <= pageBytes)) {
		return undefined
	}
	const end = characterEnd(bytes, pageBytes)
	return json({
		path,
		offset,
		byteOffset: start,
		content: new TextDecoder().decode(bytes.subarray(0, end)),
		truncated: true,
		nextOffset: offset,
		nextByteOffset: start + end,
		note: `Line ${offset} is longer than one page; this is part of it. Read on with offset ${offset} and nextByteOffset.`,
	})
}
