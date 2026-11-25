import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, relative, resolve } from "node:path"
import { parseSync } from "oxc-parser"

export const REPO_ROOT = resolve(import.meta.dirname, "../../..")

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u

const FORBIDDEN_DIRECTIVE =
	/\b(?:oxlint|eslint)-(?:disable|enable)(?:-(?:next-)?line)?\b|@ts-(?:ignore|expect-error|nocheck)\b|@effect-diagnostics(?:-next-line)?\b/giu

export interface DirectiveViolation {
	readonly file: string
	readonly line: number
	readonly directive: string
}

const countNewlinesBefore = (text: string, endIndex: number): number => {
	let count = 0
	const limit = Math.min(endIndex, text.length)
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 0x0a) {
			count++
		}
	}
	return count
}

export const findDirectiveViolationsInSource = (
	file: string,
	src: string,
): ReadonlyArray<DirectiveViolation> => {
	const parsed = parseSync(file, src)
	const violations: Array<DirectiveViolation> = []
	for (const comment of parsed.comments) {
		const commentLine = countNewlinesBefore(src, comment.start) + 1
		for (const match of comment.value.matchAll(FORBIDDEN_DIRECTIVE)) {
			const offsetLines = countNewlinesBefore(comment.value, match.index)
			violations.push({
				file,
				line: commentLine + offsetLines,
				directive: match[0],
			})
		}
	}
	return violations
}

export const shouldCheckFile = (filePath: string): boolean => {
	const normalized = filePath.replaceAll("\\", "/")
	return SOURCE_FILE.test(normalized) && basename(normalized) !== "routeTree.gen.ts"
}

export const listSourceFilesUnder = (
	repoRoot: string,
	pathspec?: string,
): ReadonlyArray<string> => {
	const gitArgs = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
	if (pathspec !== undefined) {
		gitArgs.push("--", pathspec)
	}
	return execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" })
		.split("\0")
		.filter((entry) => entry.length > 0 && shouldCheckFile(entry))
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
