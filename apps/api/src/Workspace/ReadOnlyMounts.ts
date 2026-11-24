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

/** The paths a git command could work in: its directory, and every argument read as a path. */
export const gitPaths = (args: ReadonlyArray<string>, cwd: string): ReadonlyArray<string> => {
	const directory = resolvePath(cwd)
	return [
		directory,
		...args.flatMap((arg) =>
			[arg, arg.slice(arg.indexOf("=") + 1)].map((path) => resolvePath(path, directory)),
		),
	]
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
	for (const path of gitPaths(args, cwd)) {
		const mount = readOnlyMountOf(mounts, path)
		if (mount !== undefined) {
			return mount
		}
	}
	return undefined
}

export interface LinkReader {
	readonly lstat: (path: string) => Promise<{ readonly isSymbolicLink: boolean }>
	readonly readlink: (path: string) => Promise<string>
}

const MAX_LINK_FOLLOWS = 40

/**
 * The path with each symbolic link along it followed, as the filesystem follows them: what a
 * call on the path reaches. The part that does not exist yet is kept as written.
 */
export const followLinks = async (path: string, links: LinkReader): Promise<string> => {
	const pending = resolvePath(path).split("/")
	const real: Array<string> = []
	let follows = 0
	for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
		if (name === "" || name === ".") {
			continue
		}
		if (name === "..") {
			real.pop()
			continue
		}
		const at = `/${[...real, name].join("/")}`
		const stat = await links.lstat(at).catch(() => undefined)
		if (stat === undefined) {
			real.push(name, ...pending)
			break
		}
		if (stat.isSymbolicLink && follows < MAX_LINK_FOLLOWS) {
			follows += 1
			const target = await links.readlink(at)
			if (target.startsWith("/")) {
				real.length = 0
			}
			pending.unshift(...target.split("/"))
			continue
		}
		real.push(name)
	}
	return resolvePath(`/${real.join("/")}`)
}
