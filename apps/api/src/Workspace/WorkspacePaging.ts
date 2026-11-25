import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { WorkspaceToolResult } from "./WorkspaceTools.ts"

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

const PATTERNS_UNBOUNDED =
	"grep searches here for the text as written: how long a pattern takes to match cannot be bounded. Search for a literal part of it."

export const MAX_GLOB_LENGTH = 256
export const MAX_GLOB_WILDCARD_RUNS = 4
const GLOB_UNBOUNDED = `A glob may be at most ${MAX_GLOB_LENGTH} characters long with at most ${MAX_GLOB_WILDCARD_RUNS} runs of *: a wider one cannot be matched in bounded time. Search a narrower path instead.`

const isBoundedGlob = (glob: string): boolean =>
	glob.length <= MAX_GLOB_LENGTH && glob.split(/\*+/u).length - 1 <= MAX_GLOB_WILDCARD_RUNS

export interface PagingFiles {
	readonly boundsPatterns?: (path: string) => boolean
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

const json = (value: unknown, isError = false): WorkspaceToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	isError,
})

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

const GREP_PAGE = 20
const EARLY_END_NOTE =
	"This page ended early to fit what one call returns; go on from nextOffset, or ask with fewer context lines."
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
	if (args.regex === true && files.boundsPatterns?.(path) !== true) {
		return json({ error: PATTERNS_UNBOUNDED }, true)
	}
	const pageSize = Math.min(args.limit ?? GREP_PAGE, GREP_PAGE)
	const start = args.offset ?? 0
	const includes = globList(args.include)
	const exclude = globList(args.exclude)
	if (![...(includes ?? []), ...(exclude ?? [])].every(isBoundedGlob)) {
		return json({ error: GLOB_UNBOUNDED }, true)
	}
	const include =
		includes === undefined
			? undefined
			: includes.length === 1
				? includes[0]
				: `{${includes.join(",")}}`
	const matches: Array<GrepMatch> = []
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
	let found: ReadonlyArray<GrepMatch>
	try {
		found = await files.grep(args.query, path, {
			regex: args.regex ?? false,
			ignoreCase: args.ignoreCase ?? false,
			context: args.context ?? 0,
			limit: pageSize + 1,
			offset: start,
			...(include === undefined ? {} : { include }),
			...(exclude === undefined ? {} : { exclude }),
		})
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, true)
	}
	const more = found.length > pageSize
	let full = false
	for (const each of found.slice(0, pageSize)) {
		const match: GrepMatch = {
			path: each.path,
			line: each.line,
			text: clip(each.text),
			...(each.context === undefined
				? {}
				: { context: each.context.map((line) => ({ ...line, text: clip(line.text) })) }),
		}
		const cost = byteLength(JSON.stringify(match)) + 1
		if (bytes + cost > maxBytes) {
			if (matches.length === 0) {
				matches.push({ path: match.path, line: match.line, text: match.text })
			}
			full = true
			break
		}
		matches.push(match)
		bytes += cost
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

const FindGlobs = Schema.Struct({ pattern: Schema.optionalKey(Schema.String), exclude: Globs })

export const refusedFind = (input: unknown): WorkspaceToolResult | undefined => {
	const decoded = Schema.decodeUnknownOption(FindGlobs)(input)
	if (Option.isNone(decoded)) {
		return undefined
	}
	const { pattern, exclude } = decoded.value
	return [...(pattern === undefined ? [] : [pattern]), ...(globList(exclude) ?? [])].every(
		isBoundedGlob,
	)
		? undefined
		: json({ error: GLOB_UNBOUNDED }, true)
}
