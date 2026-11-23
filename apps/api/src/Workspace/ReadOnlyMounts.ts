const WORKING_DIRECTORY = "/workspace"

/** A path as the filesystem will see it: absolute, with no ".", ".." or empty segment. */
export const resolvePath = (path: string, cwd = WORKING_DIRECTORY): string => {
	const segments: Array<string> = []
	for (const segment of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
		if (segment === "..") {
			segments.pop()
		} else if (segment !== "" && segment !== ".") {
			segments.push(segment)
		}
	}
	return `/${segments.join("/")}`
}

/**
 * The read-only mount a path is in, compared after the path is resolved. A call
 * that removes a whole subtree also touches every mount below its path.
 */
export const readOnlyMountOf = (
	mounts: ReadonlyArray<string>,
	path: string,
	options?: { readonly cwd?: string; readonly subtree?: boolean },
): string | undefined => {
	const resolved = resolvePath(path, options?.cwd)
	const below = resolved === "/" ? "/" : `${resolved}/`
	return mounts.find(
		(mount) =>
			resolved === mount ||
			resolved.startsWith(`${mount}/`) ||
			(options?.subtree === true && mount.startsWith(below)),
	)
}

/**
 * The read-only mount a git command would work in: its working directory, or
 * any argument that names a path there, alone or after an "=".
 */
export const readOnlyMountOfGit = (
	mounts: ReadonlyArray<string>,
	args: ReadonlyArray<string>,
	cwd: string,
): string | undefined => {
	const directory = resolvePath(cwd)
	for (const candidate of [
		directory,
		...args.flatMap((arg) => [arg, arg.slice(arg.indexOf("=") + 1)]),
	]) {
		const mount = readOnlyMountOf(mounts, candidate, { cwd: directory })
		if (mount !== undefined) {
			return mount
		}
	}
	return undefined
}
