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
 * never falling back to a bare name, relative PATH entries, or the caller's working directory.
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

	const cwdKey = canonicalKey(cwd)
	const resolvedRealCwd = safeRealpath(cwd)
	const realCwdKey = resolvedRealCwd !== undefined ? canonicalKey(resolvedRealCwd) : undefined

	const isWorkingDirectory = (dir) => {
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

	const candidateDirs = []
	const seenDirs = new Set()
	const addTrustedDir = (rawDir) => {
		const resolved = isTrustedAbsoluteDir(rawDir, platform, pathModule)
		if (resolved === undefined || isWorkingDirectory(resolved)) {
			return
		}
		const key = canonicalKey(resolved)
		if (seenDirs.has(key)) {
			return
		}
		seenDirs.add(key)
		candidateDirs.push(resolved)
	}

	// 1. Trusted absolute, non-cwd entries from PATH in caller precedence order
	const rawPath = getEnvValue(env, "PATH", platform)
	if (rawPath !== undefined) {
		const delimiter = platform === "win32" ? ";" : ":"
		for (const entry of rawPath.split(delimiter)) {
			addTrustedDir(entry)
		}
	}

	// 2. Trusted absolute BUN_INSTALL/bin fallback (ignoring relative or cwd-rooted values)
	const rawBunInstall = getEnvValue(env, "BUN_INSTALL", platform)
	if (rawBunInstall !== undefined) {
		const bunInstallDir = isTrustedAbsoluteDir(rawBunInstall, platform, pathModule)
		if (bunInstallDir !== undefined && !isWorkingDirectory(bunInstallDir)) {
			addTrustedDir(pathModule.join(bunInstallDir, "bin"))
		}
	}

	// 3. Trusted user default Bun install directory (~/.bun/bin)
	if (typeof homedir === "string") {
		const trustedHome = isTrustedAbsoluteDir(homedir, platform, pathModule)
		if (trustedHome !== undefined) {
			addTrustedDir(pathModule.join(trustedHome, ".bun", "bin"))
		}
	}

	// 4. Standard POSIX system directories as last-resort fallback
	if (platform !== "win32") {
		for (const sysDir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
			addTrustedDir(sysDir)
		}
	}

	const executableNames = platform === "win32" ? ["bun.exe"] : ["bun"]
	for (const dir of candidateDirs) {
		for (const exeName of executableNames) {
			const candidate = pathModule.join(dir, exeName)
			if (!isExecutableFile(candidate)) {
				continue
			}
			const realCandidate = safeRealpath(candidate)
			if (realCandidate !== undefined && isWorkingDirectory(pathModule.dirname(realCandidate))) {
				continue
			}
			return candidate
		}
	}

	return null
}
