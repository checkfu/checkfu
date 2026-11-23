import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { homedir as defaultHomedir } from "node:os"
import path from "node:path"

const WINDOWS_ABSOLUTE_DIR_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/

const defaultIsExecutableFile = (candidate, platform) => {
	try {
		if (!statSync(candidate).isFile()) {
			return false
		}
		if (platform !== "win32") {
			accessSync(candidate, constants.X_OK)
		}
		return true
	} catch {
		return false
	}
}

const getEnvValue = (env, name, platform) => {
	if (platform !== "win32") {
		const direct = env[name]
		return typeof direct === "string" ? direct : undefined
	}
	const lower = name.toLowerCase()
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === lower && typeof value === "string") {
			return value
		}
	}
	return undefined
}

const stripSurroundingQuotes = (value, platform) => {
	if (platform === "win32" && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1)
	}
	return value
}

const isTrustedAbsoluteDir = (rawDir, platform, pathModule) => {
	const dir = stripSurroundingQuotes(rawDir, platform)
	if (dir.length === 0 || dir.trim().length === 0) {
		return undefined
	}
	if (!pathModule.isAbsolute(dir)) {
		return undefined
	}
	if (platform === "win32" && !WINDOWS_ABSOLUTE_DIR_RE.test(dir)) {
		return undefined
	}
	return pathModule.resolve(dir)
}

/**
 * Resolve the Bun executable from trusted absolute PATH or installation directories,
 * excluding bare names, relative PATH entries, and any directory or resolved target
 * inside the caller's working tree (such as an absolute `node_modules/.bin` prepended
 * by a package runner), while handling explicitly trusted installation directories
 * separately (for example `~/.bun/bin` when running from `$HOME`).
 */
export const resolveBunExecutable = (options = {}) => {
	const platform = options.platform ?? process.platform
	const env = options.env ?? process.env
	const cwd = options.cwd ?? process.cwd()
	const homedir = options.homedir ?? defaultHomedir()
	const pathModule = platform === "win32" ? path.win32 : path.posix
	const isExecutableFile =
		options.isExecutableFile ?? ((candidate) => defaultIsExecutableFile(candidate, platform))
	const realpath = options.realpath ?? realpathSync

	const safeRealpath = (target) => {
		try {
			return realpath(target)
		} catch {
			return undefined
		}
	}

	const canonicalKey = (target) => {
		const normalized = pathModule.resolve(target)
		return platform === "win32" ? normalized.toLowerCase() : normalized
	}

	const isPathEqualOrWithin = (targetKey, rootKey) => {
		const rel = pathModule.relative(rootKey, targetKey)
		return rel === "" || (!rel.startsWith("..") && !pathModule.isAbsolute(rel))
	}

	const cwdKey = canonicalKey(cwd)
	const resolvedRealCwd = safeRealpath(cwd)
	const realCwdKey = resolvedRealCwd !== undefined ? canonicalKey(resolvedRealCwd) : undefined

	const isExactWorkingDirectory = (dir) => {
		const key = canonicalKey(dir)
		if (key === cwdKey || (realCwdKey !== undefined && key === realCwdKey)) {
			return true
		}
		const realDir = safeRealpath(dir)
		if (realDir === undefined) {
			return false
		}
		const realKey = canonicalKey(realDir)
		return realKey === cwdKey || (realCwdKey !== undefined && realKey === realCwdKey)
	}

	const isWithinWorkingTree = (target) => {
		const key = canonicalKey(target)
		if (
			isPathEqualOrWithin(key, cwdKey) ||
			(realCwdKey !== undefined && isPathEqualOrWithin(key, realCwdKey))
		) {
			return true
		}
		const realTarget = safeRealpath(target)
		if (realTarget === undefined) {
			return false
		}
		const realKey = canonicalKey(realTarget)
		return (
			isPathEqualOrWithin(realKey, cwdKey) ||
			(realCwdKey !== undefined && isPathEqualOrWithin(realKey, realCwdKey))
		)
	}

	// Build explicitly trusted installation bin directories and roots separately from
	// caller PATH entries so standard installations (such as ~/.bun/bin when cwd is $HOME,
	// or /opt/homebrew/bin when cwd is /) remain usable while project-local directories
	// like <cwd>/node_modules/.bin are always rejected.
	const trustedInstallBinKeys = new Set()
	const trustedInstallRootKeys = new Set()
	const fallbackInstallDirs = []

	const registerTrustedInstall = (binDir, rootDir) => {
		const resolvedBin = isTrustedAbsoluteDir(binDir, platform, pathModule)
		if (resolvedBin === undefined || isExactWorkingDirectory(resolvedBin)) {
			return
		}
		trustedInstallBinKeys.add(canonicalKey(resolvedBin))
		const realBin = safeRealpath(resolvedBin)
		if (realBin !== undefined) {
			trustedInstallBinKeys.add(canonicalKey(realBin))
		}
		const resolvedRoot = isTrustedAbsoluteDir(rootDir, platform, pathModule)
		if (resolvedRoot !== undefined) {
			trustedInstallRootKeys.add(canonicalKey(resolvedRoot))
			const realRoot = safeRealpath(resolvedRoot)
			if (realRoot !== undefined) {
				trustedInstallRootKeys.add(canonicalKey(realRoot))
			}
		}
		fallbackInstallDirs.push(resolvedBin)
	}

	const trustedHome =
		typeof homedir === "string" ? isTrustedAbsoluteDir(homedir, platform, pathModule) : undefined
	const defaultUserBunRoot =
		trustedHome !== undefined ? pathModule.join(trustedHome, ".bun") : undefined

	// Trust BUN_INSTALL only when it is absolute and outside the working tree
	// (or explicitly matches the user's ~/.bun installation root).
	const rawBunInstall = getEnvValue(env, "BUN_INSTALL", platform)
	if (rawBunInstall !== undefined) {
		const bunInstallDir = isTrustedAbsoluteDir(rawBunInstall, platform, pathModule)
		const isDefaultUserBun =
			bunInstallDir !== undefined &&
			defaultUserBunRoot !== undefined &&
			canonicalKey(bunInstallDir) === canonicalKey(defaultUserBunRoot)
		if (
			bunInstallDir !== undefined &&
			!isExactWorkingDirectory(bunInstallDir) &&
			(isDefaultUserBun || !isWithinWorkingTree(bunInstallDir))
		) {
			registerTrustedInstall(pathModule.join(bunInstallDir, "bin"), bunInstallDir)
		}
	}

	if (defaultUserBunRoot !== undefined) {
		registerTrustedInstall(pathModule.join(defaultUserBunRoot, "bin"), defaultUserBunRoot)
	}

	if (platform === "win32") {
		const programFiles = getEnvValue(env, "ProgramFiles", platform)
		if (programFiles !== undefined) {
			const pfDir = isTrustedAbsoluteDir(programFiles, platform, pathModule)
			if (pfDir !== undefined) {
				const bunRoot = pathModule.join(pfDir, "Bun")
				registerTrustedInstall(pathModule.join(bunRoot, "bin"), bunRoot)
			}
		}
		const localAppData = getEnvValue(env, "LOCALAPPDATA", platform)
		if (localAppData !== undefined) {
			const ladDir = isTrustedAbsoluteDir(localAppData, platform, pathModule)
			if (ladDir !== undefined) {
				const programsBun = pathModule.join(ladDir, "Programs", "bun")
				registerTrustedInstall(pathModule.join(programsBun, "bin"), programsBun)
				const wingetRoot = pathModule.join(ladDir, "Microsoft", "WinGet")
				registerTrustedInstall(pathModule.join(wingetRoot, "Links"), wingetRoot)
			}
		}
		if (trustedHome !== undefined) {
			const scoopRoot = pathModule.join(trustedHome, "scoop")
			registerTrustedInstall(pathModule.join(scoopRoot, "shims"), scoopRoot)
			registerTrustedInstall(pathModule.join(scoopRoot, "apps", "bun", "current"), scoopRoot)
		}
	} else {
		registerTrustedInstall("/opt/homebrew/bin", "/opt/homebrew")
		registerTrustedInstall("/usr/local/bin", "/usr/local")
		registerTrustedInstall("/usr/bin", "/usr")
		registerTrustedInstall("/bin", "/bin")
	}

	const isTrustedInstallBinDir = (dir) => {
		if (trustedInstallBinKeys.has(canonicalKey(dir))) {
			return true
		}
		const realDir = safeRealpath(dir)
		return realDir !== undefined && trustedInstallBinKeys.has(canonicalKey(realDir))
	}

	const isWithinTrustedInstallRoot = (target) => {
		const key = canonicalKey(target)
		for (const rootKey of trustedInstallRootKeys) {
			if (isPathEqualOrWithin(key, rootKey)) {
				return true
			}
		}
		const realTarget = safeRealpath(target)
		if (realTarget === undefined) {
			return false
		}
		const realKey = canonicalKey(realTarget)
		for (const rootKey of trustedInstallRootKeys) {
			if (isPathEqualOrWithin(realKey, rootKey)) {
				return true
			}
		}
		return false
	}

	const candidateDirs = []
	const seenDirs = new Set()
	const addCandidateDir = (rawDir, allowTrustedInstallOnly = false) => {
		const resolved = isTrustedAbsoluteDir(rawDir, platform, pathModule)
		if (resolved === undefined || isExactWorkingDirectory(resolved)) {
			return
		}
		const trustedBin = isTrustedInstallBinDir(resolved)
		if (allowTrustedInstallOnly && !trustedBin) {
			return
		}
		if (isWithinWorkingTree(resolved) && !trustedBin) {
			return
		}
		const key = canonicalKey(resolved)
		if (seenDirs.has(key)) {
			return
		}
		seenDirs.add(key)
		candidateDirs.push(resolved)
	}

	// 1. Trusted absolute PATH entries outside the untrusted working tree
	//    (explicitly trusted install directories remain allowed in caller precedence order)
	const rawPath = getEnvValue(env, "PATH", platform)
	if (rawPath !== undefined) {
		const delimiter = platform === "win32" ? ";" : ":"
		for (const entry of rawPath.split(delimiter)) {
			addCandidateDir(entry)
		}
	}

	// 2. Explicitly trusted installation directories as fallback
	for (const installDir of fallbackInstallDirs) {
		addCandidateDir(installDir, true)
	}

	const executableNames = platform === "win32" ? ["bun.exe"] : ["bun"]
	for (const dir of candidateDirs) {
		for (const exeName of executableNames) {
			const candidate = pathModule.join(dir, exeName)
			if (!isExecutableFile(candidate)) {
				continue
			}
			const realCandidate = safeRealpath(candidate) ?? candidate
			if (isExactWorkingDirectory(pathModule.dirname(realCandidate))) {
				continue
			}
			if (isWithinWorkingTree(realCandidate) && !isWithinTrustedInstallRoot(realCandidate)) {
				continue
			}
			return candidate
		}
	}

	return null
}
