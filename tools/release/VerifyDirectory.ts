import { spawnSync } from "node:child_process"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const evidencePathError = (path: string) =>
	new Error(
		"Unsafe verification output path " +
			path +
			". Choose an ignored directory such as .checkfu/verification, or a directory outside the checkout.",
	)

const realDirectory = (path: string): string => {
	const entry = lstatSync(path, { throwIfNoEntry: false })
	if (entry !== undefined) {
		const directory = realpathSync(path)
		if (!statSync(directory).isDirectory()) {
			throw evidencePathError(path)
		}
		return directory
	}
	return join(realDirectory(dirname(path)), basename(path))
}

const git = (root: string, args: ReadonlyArray<string>) => {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
	if (result.error !== undefined) {
		throw result.error
	}
	return result
}

const validateOutput = (root: string, path: string) => {
	const entry = lstatSync(path, { throwIfNoEntry: false })
	if (entry !== undefined && (!entry.isFile() || entry.nlink !== 1)) {
		throw evidencePathError(path)
	}
	const file = relative(root, entry === undefined ? path : realpathSync.native(path))
	if (isAbsolute(file) || file === ".." || file.startsWith(".." + sep)) {
		return
	}
	const tracked = git(root, ["--literal-pathspecs", "ls-files", "--cached", "--", file])
	if (tracked.status !== 0 || tracked.stdout !== "") {
		throw evidencePathError(path)
	}
	if (git(root, ["check-ignore", "--quiet", "--", file]).status !== 0) {
		throw evidencePathError(path)
	}
}

export const prepareEvidenceDirectory = (
	repoRoot: string,
	path: string,
	outputNames: ReadonlyArray<string>,
	githubSummary?: string,
): string => {
	const root = realpathSync(repoRoot)
	const directory = realDirectory(resolve(path))
	for (const output of outputNames) {
		validateOutput(root, join(directory, output))
	}
	if (githubSummary !== undefined) {
		const absolute = resolve(githubSummary)
		validateOutput(root, join(realDirectory(dirname(absolute)), basename(absolute)))
	}
	return directory
}
