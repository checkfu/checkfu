import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"

export const REPO_ROOT = resolve(import.meta.dirname, "../../..")

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u

const FORBIDDEN_DIRECTIVE =
	/\b(?:oxlint|eslint)-(?:disable|enable)(?:-(?:next-)?line)?\b|@ts-(?:ignore|expect-error|nocheck)\b|@effect-diagnostics(?:-next-line)?\b/iu

const EXPR_PREFIX_KEYWORDS = new Set([
	"await",
	"case",
	"delete",
	"else",
	"in",
	"instanceof",
	"new",
	"of",
	"return",
	"throw",
	"typeof",
	"void",
	"yield",
])

export interface DirectiveViolation {
	readonly file: string
	readonly line: number
	readonly directive: string
}

export interface ExtractedComment {
	readonly line: number
	readonly text: string
}

const isIdentStart = (ch: number): boolean =>
	(ch >= 0x41 && ch <= 0x5a) ||
	(ch >= 0x61 && ch <= 0x7a) ||
	ch === 0x5f ||
	ch === 0x24 ||
	ch > 0x7f

const isIdentPart = (ch: number): boolean => isIdentStart(ch) || (ch >= 0x30 && ch <= 0x39)

const tryScanRegex = (src: string, slashIndex: number): number => {
	let i = slashIndex + 1
	let inCharClass = false
	while (i < src.length) {
		const ch = src.charCodeAt(i)
		if (ch === 0x0a || ch === 0x0d) {
			return -1
		}
		if (ch === 0x5c) {
			i += 2
			continue
		}
		if (ch === 0x5b) {
			inCharClass = true
			i++
			continue
		}
		if (ch === 0x5d && inCharClass) {
			inCharClass = false
			i++
			continue
		}
		if (ch === 0x2f && !inCharClass) {
			i++
			while (i < src.length && isIdentPart(src.charCodeAt(i))) {
				i++
			}
			return i
		}
		i++
	}
	return -1
}

export const extractComments = (src: string): ReadonlyArray<ExtractedComment> => {
	const comments: Array<ExtractedComment> = []
	const templateBraceDepths: Array<number> = []
	let braceDepth = 0
	let canStartRegex = true
	let prevWasDot = false
	let line = 1
	let i = 0

	if (src.startsWith("#!")) {
		while (i < src.length && src.charCodeAt(i) !== 0x0a) {
			i++
		}
	}

	const scanTemplateTail = (startIndex: number): number => {
		let pos = startIndex
		while (pos < src.length) {
			const ch = src.charCodeAt(pos)
			if (ch === 0x0a) {
				line++
				pos++
				continue
			}
			if (ch === 0x5c) {
				if (pos + 1 < src.length && src.charCodeAt(pos + 1) === 0x0a) {
					line++
				}
				pos += 2
				continue
			}
			if (ch === 0x60) {
				canStartRegex = false
				return pos + 1
			}
			if (ch === 0x24 && pos + 1 < src.length && src.charCodeAt(pos + 1) === 0x7b) {
				templateBraceDepths.push(braceDepth)
				braceDepth++
				canStartRegex = true
				return pos + 2
			}
			pos++
		}
		return pos
	}

	while (i < src.length) {
		const ch = src.charCodeAt(i)
		if (ch === 0x0a) {
			line++
			i++
			continue
		}
		if (ch === 0x20 || ch === 0x09 || ch === 0x0d) {
			i++
			continue
		}
		if (ch === 0x2f && i + 1 < src.length) {
			const next = src.charCodeAt(i + 1)
			if (next === 0x2f) {
				const commentLine = line
				const start = i + 2
				i += 2
				while (i < src.length && src.charCodeAt(i) !== 0x0a) {
					i++
				}
				comments.push({ line: commentLine, text: src.slice(start, i) })
				continue
			}
			if (next === 0x2a) {
				const commentLine = line
				const start = i + 2
				i += 2
				while (
					i < src.length &&
					!(src.charCodeAt(i) === 0x2a && i + 1 < src.length && src.charCodeAt(i + 1) === 0x2f)
				) {
					if (src.charCodeAt(i) === 0x0a) {
						line++
					}
					i++
				}
				comments.push({ line: commentLine, text: src.slice(start, i) })
				i = Math.min(src.length, i + 2)
				continue
			}
		}
		if (ch === 0x22 || ch === 0x27) {
			const quote = ch
			i++
			while (i < src.length && src.charCodeAt(i) !== quote) {
				if (src.charCodeAt(i) === 0x0a) {
					line++
				}
				if (src.charCodeAt(i) === 0x5c) {
					if (i + 1 < src.length && src.charCodeAt(i + 1) === 0x0a) {
						line++
					}
					i += 2
					continue
				}
				i++
			}
			i = Math.min(src.length, i + 1)
			canStartRegex = false
			continue
		}
		if (ch === 0x60) {
			i = scanTemplateTail(i + 1)
			continue
		}
		if (ch === 0x7b) {
			braceDepth++
			canStartRegex = true
			i++
			continue
		}
		if (ch === 0x7d) {
			braceDepth = Math.max(0, braceDepth - 1)
			if (templateBraceDepths.at(-1) === braceDepth) {
				templateBraceDepths.pop()
				i = scanTemplateTail(i + 1)
				continue
			}
			canStartRegex = true
			i++
			continue
		}
		if (ch === 0x2f && canStartRegex) {
			const regexEnd = tryScanRegex(src, i)
			if (regexEnd !== -1) {
				i = regexEnd
				canStartRegex = false
				continue
			}
		}
		if (isIdentStart(ch)) {
			const start = i
			i++
			while (i < src.length && isIdentPart(src.charCodeAt(i))) {
				i++
			}
			const word = src.slice(start, i)
			canStartRegex = !prevWasDot && EXPR_PREFIX_KEYWORDS.has(word)
			prevWasDot = false
			continue
		}
		if (ch >= 0x30 && ch <= 0x39) {
			i++
			while (i < src.length && (isIdentPart(src.charCodeAt(i)) || src.charCodeAt(i) === 0x2e)) {
				i++
			}
			canStartRegex = false
			prevWasDot = false
			continue
		}
		if (
			(ch === 0x2b && i + 1 < src.length && src.charCodeAt(i + 1) === 0x2b) ||
			(ch === 0x2d && i + 1 < src.length && src.charCodeAt(i + 1) === 0x2d)
		) {
			canStartRegex = false
			prevWasDot = false
			i += 2
			continue
		}
		prevWasDot = ch === 0x2e
		canStartRegex = ch !== 0x29 && ch !== 0x5d
		i++
	}

	return comments
}

export const findDirectiveViolationsInSource = (
	file: string,
	src: string,
): ReadonlyArray<DirectiveViolation> => {
	const violations: Array<DirectiveViolation> = []
	for (const comment of extractComments(src)) {
		const match = FORBIDDEN_DIRECTIVE.exec(comment.text)
		if (match !== null) {
			const offsetLines = comment.text.slice(0, match.index).split("\n").length - 1
			violations.push({
				file,
				line: comment.line + offsetLines,
				directive: match[0],
			})
		}
	}
	return violations
}

export const shouldCheckFile = (filePath: string): boolean =>
	SOURCE_FILE.test(filePath) && !filePath.endsWith("routeTree.gen.ts")

const listSourceFilesUnder = (repoRoot: string, pathspec?: string): ReadonlyArray<string> => {
	const gitArgs = ["ls-files", "--cached", "--others", "--exclude-standard"]
	if (pathspec !== undefined) {
		gitArgs.push("--", pathspec)
	}
	return execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" })
		.trim()
		.split("\n")
		.filter((line) => line.length > 0 && shouldCheckFile(line))
}

export const checkDirectiveFiles = (
	files: ReadonlyArray<string>,
	repoRoot: string = REPO_ROOT,
): ReadonlyArray<DirectiveViolation> => {
	const expanded: Array<string> = []
	for (const candidate of files) {
		const abs = resolve(repoRoot, candidate)
		if (!existsSync(abs)) {
			continue
		}
		if (statSync(abs).isDirectory()) {
			const relDir = relative(repoRoot, abs)
			expanded.push(...listSourceFilesUnder(repoRoot, relDir === "" ? undefined : relDir))
		} else if (shouldCheckFile(candidate)) {
			expanded.push(candidate)
		}
	}
	const violations: Array<DirectiveViolation> = []
	for (const candidate of expanded) {
		const abs = resolve(repoRoot, candidate)
		if (!existsSync(abs)) {
			continue
		}
		const rel = relative(repoRoot, abs)
		const src = readFileSync(abs, "utf8")
		violations.push(...findDirectiveViolationsInSource(rel, src))
	}
	return violations
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename

if (isMain) {
	const args = process.argv.slice(2)
	const files = args.length > 0 ? args : listSourceFilesUnder(REPO_ROOT)
	const violations = checkDirectiveFiles(files, REPO_ROOT)
	if (violations.length > 0) {
		for (const v of violations) {
			process.stderr.write(
				`${v.file}:${v.line}: forbidden inline suppression directive "${v.directive}"\n`,
			)
		}
		process.exit(1)
	}
}
