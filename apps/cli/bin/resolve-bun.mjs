import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs"
import { homedir as defaultHomedir } from "node:os"
import path from "node:path"

const WINDOWS_ABSOLUTE_DIR_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/

const CHECKOUT_MARKERS = [
	".git",
	"package.json",
	"bun.lock",
	"bun.lockb",
	"bunfig.toml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"package-lock.json",
	"turbo.json",
]

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

const isTrustedAbsolutePath = (rawPath, platform, pathModule) => {
	const value = stripSurroundingQuotes(rawPath, platform)
	if (value.length === 0 || value.trim().length === 0) {
		return undefined
	}
	if (!pathModule.isAbsolute(value)) {
		return undefined
	}
	if (platform === "win32" && !WINDOWS_ABSOLUTE_DIR_RE.test(value)) {
		return undefined
	}
	return pathModule.resolve(value)
}

const hasNodeModulesSegment = (target, platform) =>
	target
		.split(/[\\/]/)
		.some((segment) =>
			platform === "win32" ? segment.toLowerCase() === "node_modules" : segment === "node_modules",
		)

/**
 * Resolve the Bun executable exclusively from explicitly trusted installation roots
 * (or an explicit `CHECKFU_BUN_PATH` / `BUN_INSTALL` override outside the enclosing
 * checkout).
 *
 * Security invariants:
 * - An absolute PATH entry alone is NOT trusted: both the candidate directory and its
 *   `realpath`-resolved executable must live inside an explicitly trusted installation
 *   root (e.g. `~/.bun`, `BUN_INSTALL`, `/opt/homebrew`, `/usr/local`, `/usr`, `/bin`,
 *   `%ProgramFiles%\Bun`, WinGet, Scoop, Chocolatey, or CI toolcache roots).
 * - The working directory, its entire enclosing checkout/workspace tree (discovered by
 *   walking upward for checkout markers before `$HOME` and filesystem root), any path
 *   containing `node_modules`, relative/empty/drive-relative entries, and bare executable
 *   names are always excluded.
 * - Containment checks reject only an actual parent component (`..` or `..` + separator),
 *   so descendant directories whose names start with `..` (such as `..evil`) remain inside
 *   the excluded checkout tree.
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
	const pathExists = options.pathExists ?? existsSync

	const safeRealpath = (target) => {
		try {
			return realpath(target)
		} catch {
			return undefined
		}
	}

	const safePathExists = (target) => {
		try {
			return pathExists(target)
		} catch {
			return false
		}
	}

	const canonicalKey = (target) => {
		const normalized = pathModule.resolve(target)
		return platform === "win32" ? normalized.toLowerCase() : normalized
	}

	const isPathEqualOrWithin = (targetKey, rootKey) => {
		const rel = pathModule.relative(rootKey, targetKey)
		if (rel === "") {
			return true
		}
		if (pathModule.isAbsolute(rel)) {
			return false
		}
		// Reject only a parent-traversal component (".." or ".." followed by a separator),
		// never a descendant directory whose name merely starts with ".." (like "..evil").
		if (rel === ".." || rel.startsWith(`..${pathModule.sep}`)) {
			return false
		}
		if (platform === "win32" && rel.startsWith("../")) {
			return false
		}
		return true
	}

	const trustedHome =
		typeof homedir === "string" ? isTrustedAbsolutePath(homedir, platform, pathModule) : undefined
	const homeKeys = new Set()
	if (trustedHome !== undefined) {
		homeKeys.add(canonicalKey(trustedHome))
		const realHome = safeRealpath(trustedHome)
		if (realHome !== undefined) {
			homeKeys.add(canonicalKey(realHome))
		}
	}

	const exactWorkingDirKeys = new Set()
	const normalizedCwd = pathModule.resolve(cwd)
	exactWorkingDirKeys.add(canonicalKey(normalizedCwd))
	const resolvedRealCwd = safeRealpath(normalizedCwd)
	if (resolvedRealCwd !== undefined) {
		exactWorkingDirKeys.add(canonicalKey(resolvedRealCwd))
	}

	// Discover the outermost enclosing checkout/workspace root by walking upward from
	// cwd (stopping strictly before $HOME and filesystem root) so invocations from nested
	// workspace subdirectories exclude top-level checkout directories like <repo>/node_modules/.bin.
	const checkoutRootKeys = new Set()
	const addCheckoutRoot = (dir) => {
		const key = canonicalKey(dir)
		checkoutRootKeys.add(key)
		const realDir = safeRealpath(dir)
		if (realDir !== undefined) {
			checkoutRootKeys.add(canonicalKey(realDir))
		}
	}

	const discoverEnclosingCheckout = (startDir) => {
		let cursor = pathModule.resolve(startDir)
		let outermostMarked
		for (;;) {
			const parent = pathModule.dirname(cursor)
			if (parent === cursor || homeKeys.has(canonicalKey(cursor))) {
				break
			}
			const hasMarker = CHECKOUT_MARKERS.some((marker) =>
				safePathExists(pathModule.join(cursor, marker)),
			)
			if (hasMarker) {
				outermostMarked = cursor
			}
			cursor = parent
		}
		if (outermostMarked !== undefined) {
			addCheckoutRoot(outermostMarked)
		}
	}

	discoverEnclosingCheckout(normalizedCwd)
	if (
		resolvedRealCwd !== undefined &&
		canonicalKey(resolvedRealCwd) !== canonicalKey(normalizedCwd)
	) {
		discoverEnclosingCheckout(resolvedRealCwd)
	}

	const isExactWorkingDirectory = (dir) => {
		if (exactWorkingDirKeys.has(canonicalKey(dir))) {
			return true
		}
		const realDir = safeRealpath(dir)
		return realDir !== undefined && exactWorkingDirKeys.has(canonicalKey(realDir))
	}

	const isInsideEnclosingCheckout = (target) => {
		const key = canonicalKey(target)
		for (const rootKey of checkoutRootKeys) {
			if (isPathEqualOrWithin(key, rootKey)) {
				return true
			}
		}
		const realTarget = safeRealpath(target)
		if (realTarget === undefined) {
			return false
		}
		const realKey = canonicalKey(realTarget)
		for (const rootKey of checkoutRootKeys) {
			if (isPathEqualOrWithin(realKey, rootKey)) {
				return true
			}
		}
		return false
	}

	const isInsideCwdTree = (target) => {
		const key = canonicalKey(target)
		for (const cwdKey of exactWorkingDirKeys) {
			if (isPathEqualOrWithin(key, cwdKey)) {
				return true
			}
		}
		const realTarget = safeRealpath(target)
		if (realTarget === undefined) {
			return false
		}
		const realKey = canonicalKey(realTarget)
		for (const cwdKey of exactWorkingDirKeys) {
			if (isPathEqualOrWithin(realKey, cwdKey)) {
				return true
			}
		}
		return false
	}

	// Explicit operator override (`CHECKFU_BUN_PATH`): validated strictly and fail-closed
	// so misconfigured or checkout-local overrides never silently fall through.
	const rawExplicitBun = getEnvValue(env, "CHECKFU_BUN_PATH", platform)
	if (rawExplicitBun !== undefined && rawExplicitBun.trim().length > 0) {
		const explicitPath = isTrustedAbsolutePath(rawExplicitBun, platform, pathModule)
		if (explicitPath === undefined) {
			return null
		}
		if (platform === "win32" && !explicitPath.toLowerCase().endsWith(".exe")) {
			return null
		}
		if (!isExecutableFile(explicitPath)) {
			return null
		}
		const realExplicit = safeRealpath(explicitPath) ?? explicitPath
		if (
			hasNodeModulesSegment(explicitPath, platform) ||
			hasNodeModulesSegment(realExplicit, platform) ||
			isExactWorkingDirectory(pathModule.dirname(explicitPath)) ||
			isExactWorkingDirectory(pathModule.dirname(realExplicit)) ||
			isInsideEnclosingCheckout(explicitPath) ||
			isInsideEnclosingCheckout(realExplicit) ||
			isInsideCwdTree(explicitPath) ||
			isInsideCwdTree(realExplicit)
		) {
			return null
		}
		return explicitPath
	}

	// Explicitly trusted installation bin directories, dynamic versioned bin roots (e.g.
	// /nix/store, mise/asdf/proto installs, CI toolcaches), and symlink target roots.
	const trustedBinDirKeys = new Set()
	const trustedDynamicBinRootKeys = new Set()
	const trustedTargetRootKeys = new Set()
	const fallbackBinDirs = []

	const addTrustedTargetRoot = (rootDir) => {
		const resolvedRoot = isTrustedAbsolutePath(rootDir, platform, pathModule)
		if (
			resolvedRoot === undefined ||
			hasNodeModulesSegment(resolvedRoot, platform) ||
			isInsideEnclosingCheckout(resolvedRoot)
		) {
			return undefined
		}
		trustedTargetRootKeys.add(canonicalKey(resolvedRoot))
		const realRoot = safeRealpath(resolvedRoot)
		if (
			realRoot !== undefined &&
			!hasNodeModulesSegment(realRoot, platform) &&
			!isInsideEnclosingCheckout(realRoot)
		) {
			trustedTargetRootKeys.add(canonicalKey(realRoot))
		}
		return resolvedRoot
	}

	const addTrustedDynamicBinRoot = (rootDir) => {
		const resolvedRoot = addTrustedTargetRoot(rootDir)
		if (resolvedRoot === undefined) {
			return
		}
		trustedDynamicBinRootKeys.add(canonicalKey(resolvedRoot))
		const realRoot = safeRealpath(resolvedRoot)
		if (
			realRoot !== undefined &&
			!hasNodeModulesSegment(realRoot, platform) &&
			!isInsideEnclosingCheckout(realRoot)
		) {
			trustedDynamicBinRootKeys.add(canonicalKey(realRoot))
		}
	}

	const registerTrustedInstall = (binDir, rootDir) => {
		const resolvedRoot = addTrustedTargetRoot(rootDir)
		if (resolvedRoot === undefined) {
			return
		}
		const resolvedBin = isTrustedAbsolutePath(binDir, platform, pathModule)
		if (
			resolvedBin === undefined ||
			hasNodeModulesSegment(resolvedBin, platform) ||
			isExactWorkingDirectory(resolvedBin) ||
			isInsideEnclosingCheckout(resolvedBin)
		) {
			return
		}
		trustedBinDirKeys.add(canonicalKey(resolvedBin))
		const realBin = safeRealpath(resolvedBin)
		if (
			realBin !== undefined &&
			!hasNodeModulesSegment(realBin, platform) &&
			!isExactWorkingDirectory(realBin) &&
			!isInsideEnclosingCheckout(realBin)
		) {
			trustedBinDirKeys.add(canonicalKey(realBin))
		}
		fallbackBinDirs.push(resolvedBin)
	}

	const defaultUserBunRoot =
		trustedHome !== undefined ? pathModule.join(trustedHome, ".bun") : undefined

	// Trust BUN_INSTALL only when absolute, without node_modules, and outside both
	// the enclosing checkout and cwd (unless it matches the user's ~/.bun install root).
	const rawBunInstall = getEnvValue(env, "BUN_INSTALL", platform)
	if (rawBunInstall !== undefined) {
		const bunInstallDir = isTrustedAbsolutePath(rawBunInstall, platform, pathModule)
		const isDefaultUserBun =
			bunInstallDir !== undefined &&
			defaultUserBunRoot !== undefined &&
			canonicalKey(bunInstallDir) === canonicalKey(defaultUserBunRoot)
		if (
			bunInstallDir !== undefined &&
			!hasNodeModulesSegment(bunInstallDir, platform) &&
			!isExactWorkingDirectory(bunInstallDir) &&
			!isInsideEnclosingCheckout(bunInstallDir) &&
			(isDefaultUserBun || !isInsideCwdTree(bunInstallDir))
		) {
			registerTrustedInstall(pathModule.join(bunInstallDir, "bin"), bunInstallDir)
		}
	}

	// Hosted CI toolcaches (e.g. GitHub Actions RUNNER_TOOL_CACHE) when outside checkout/cwd
	for (const toolCacheEnv of ["RUNNER_TOOL_CACHE", "AGENT_TOOLSDIRECTORY"]) {
		const rawCache = getEnvValue(env, toolCacheEnv, platform)
		if (rawCache !== undefined) {
			const cacheDir = isTrustedAbsolutePath(rawCache, platform, pathModule)
			if (
				cacheDir !== undefined &&
				!hasNodeModulesSegment(cacheDir, platform) &&
				!isInsideEnclosingCheckout(cacheDir) &&
				!isInsideCwdTree(cacheDir)
			) {
				addTrustedDynamicBinRoot(cacheDir)
			}
		}
	}

	if (defaultUserBunRoot !== undefined) {
		registerTrustedInstall(pathModule.join(defaultUserBunRoot, "bin"), defaultUserBunRoot)
	}

	if (platform === "win32") {
		const programFilesCandidates = new Set()
		const programFiles = getEnvValue(env, "ProgramFiles", platform)
		if (programFiles !== undefined) {
			programFilesCandidates.add(programFiles)
		}
		const programFilesX86 = getEnvValue(env, "ProgramFiles(x86)", platform)
		if (programFilesX86 !== undefined) {
			programFilesCandidates.add(programFilesX86)
		}
		programFilesCandidates.add(String.raw`C:\Program Files`)
		programFilesCandidates.add(String.raw`C:\Program Files (x86)`)
		for (const pf of programFilesCandidates) {
			const pfDir = isTrustedAbsolutePath(pf, platform, pathModule)
			if (pfDir !== undefined) {
				const bunRoot = pathModule.join(pfDir, "Bun")
				registerTrustedInstall(pathModule.join(bunRoot, "bin"), bunRoot)
			}
		}

		const localAppData = getEnvValue(env, "LOCALAPPDATA", platform)
		if (localAppData !== undefined) {
			const ladDir = isTrustedAbsolutePath(localAppData, platform, pathModule)
			if (ladDir !== undefined) {
				const programsBun = pathModule.join(ladDir, "Programs", "bun")
				registerTrustedInstall(pathModule.join(programsBun, "bin"), programsBun)
				const wingetRoot = pathModule.join(ladDir, "Microsoft", "WinGet")
				registerTrustedInstall(pathModule.join(wingetRoot, "Links"), wingetRoot)
				addTrustedDynamicBinRoot(pathModule.join(wingetRoot, "Packages"))
			}
		}

		if (trustedHome !== undefined) {
			const scoopRoot = pathModule.join(trustedHome, "scoop")
			registerTrustedInstall(pathModule.join(scoopRoot, "shims"), scoopRoot)
			registerTrustedInstall(pathModule.join(scoopRoot, "apps", "bun", "current"), scoopRoot)
		}

		const chocoInstall = getEnvValue(env, "ChocolateyInstall", platform)
		if (chocoInstall !== undefined) {
			const chocoDir = isTrustedAbsolutePath(chocoInstall, platform, pathModule)
			if (chocoDir !== undefined) {
				registerTrustedInstall(pathModule.join(chocoDir, "bin"), chocoDir)
			}
		}
		const programData = getEnvValue(env, "ProgramData", platform) ?? String.raw`C:\ProgramData`
		const programDataDir = isTrustedAbsolutePath(programData, platform, pathModule)
		if (programDataDir !== undefined) {
			const chocoRoot = pathModule.join(programDataDir, "chocolatey")
			registerTrustedInstall(pathModule.join(chocoRoot, "bin"), chocoRoot)
		}
	} else {
		registerTrustedInstall("/opt/homebrew/bin", "/opt/homebrew")
		registerTrustedInstall("/usr/local/bin", "/usr/local")
		registerTrustedInstall("/home/linuxbrew/.linuxbrew/bin", "/home/linuxbrew/.linuxbrew")
		registerTrustedInstall("/usr/bin", "/usr")
		registerTrustedInstall("/bin", "/bin")
		registerTrustedInstall("/snap/bin", "/snap")
		registerTrustedInstall("/run/current-system/sw/bin", "/run/current-system/sw")
		addTrustedDynamicBinRoot("/nix/store")

		if (trustedHome !== undefined) {
			const nixProfile = pathModule.join(trustedHome, ".nix-profile")
			registerTrustedInstall(pathModule.join(nixProfile, "bin"), nixProfile)
			const miseRoot = pathModule.join(trustedHome, ".local", "share", "mise")
			registerTrustedInstall(pathModule.join(miseRoot, "shims"), miseRoot)
			addTrustedDynamicBinRoot(pathModule.join(miseRoot, "installs"))
			const asdfRoot = pathModule.join(trustedHome, ".asdf")
			registerTrustedInstall(pathModule.join(asdfRoot, "shims"), asdfRoot)
			addTrustedDynamicBinRoot(pathModule.join(asdfRoot, "installs"))
			const protoRoot = pathModule.join(trustedHome, ".proto")
			registerTrustedInstall(pathModule.join(protoRoot, "shims"), protoRoot)
			addTrustedDynamicBinRoot(pathModule.join(protoRoot, "tools"))
			const voltaRoot = pathModule.join(trustedHome, ".volta")
			registerTrustedInstall(pathModule.join(voltaRoot, "bin"), voltaRoot)
			const localBin = pathModule.join(trustedHome, ".local", "bin")
			registerTrustedInstall(localBin, localBin)
		}
	}

	const isWithinAnyRoot = (target, rootKeys) => {
		const key = canonicalKey(target)
		for (const rootKey of rootKeys) {
			if (isPathEqualOrWithin(key, rootKey)) {
				return true
			}
		}
		const realTarget = safeRealpath(target)
		if (realTarget === undefined) {
			return false
		}
		const realKey = canonicalKey(realTarget)
		for (const rootKey of rootKeys) {
			if (isPathEqualOrWithin(realKey, rootKey)) {
				return true
			}
		}
		return false
	}

	const isTrustedBinDir = (dir) => {
		const key = canonicalKey(dir)
		if (trustedBinDirKeys.has(key)) {
			return true
		}
		const realDir = safeRealpath(dir)
		if (realDir !== undefined && trustedBinDirKeys.has(canonicalKey(realDir))) {
			return true
		}
		return isWithinAnyRoot(dir, trustedDynamicBinRootKeys)
	}

	const isWithinTrustedTargetRoot = (target) => isWithinAnyRoot(target, trustedTargetRootKeys)

	const isCwdBroadAncestor =
		homeKeys.has(canonicalKey(normalizedCwd)) ||
		pathModule.dirname(normalizedCwd) === normalizedCwd ||
		(resolvedRealCwd !== undefined &&
			(homeKeys.has(canonicalKey(resolvedRealCwd)) ||
				pathModule.dirname(resolvedRealCwd) === resolvedRealCwd))

	const candidateDirs = []
	const seenDirs = new Set()
	const addTrustedCandidateDir = (rawDir) => {
		const resolved = isTrustedAbsolutePath(rawDir, platform, pathModule)
		if (
			resolved === undefined ||
			hasNodeModulesSegment(resolved, platform) ||
			isExactWorkingDirectory(resolved) ||
			isInsideEnclosingCheckout(resolved) ||
			(!isCwdBroadAncestor && isInsideCwdTree(resolved)) ||
			!isTrustedBinDir(resolved)
		) {
			return
		}
		const key = canonicalKey(resolved)
		if (seenDirs.has(key)) {
			return
		}
		seenDirs.add(key)
		candidateDirs.push(resolved)
	}

	// 1. Honor caller PATH order ONLY among explicitly trusted installation bin directories
	const rawPath = getEnvValue(env, "PATH", platform)
	if (rawPath !== undefined) {
		const delimiter = platform === "win32" ? ";" : ":"
		for (const entry of rawPath.split(delimiter)) {
			addTrustedCandidateDir(entry)
		}
	}

	// 2. Fallback to explicitly trusted installation bin directories even when PATH is minimal
	for (const installDir of fallbackBinDirs) {
		addTrustedCandidateDir(installDir)
	}

	const executableNames = platform === "win32" ? ["bun.exe"] : ["bun"]
	for (const dir of candidateDirs) {
		for (const exeName of executableNames) {
			const candidate = pathModule.join(dir, exeName)
			if (!isExecutableFile(candidate)) {
				continue
			}
			const realCandidate = safeRealpath(candidate) ?? candidate
			if (
				hasNodeModulesSegment(candidate, platform) ||
				hasNodeModulesSegment(realCandidate, platform) ||
				isExactWorkingDirectory(pathModule.dirname(candidate)) ||
				isExactWorkingDirectory(pathModule.dirname(realCandidate)) ||
				isInsideEnclosingCheckout(candidate) ||
				isInsideEnclosingCheckout(realCandidate) ||
				(!isCwdBroadAncestor && (isInsideCwdTree(candidate) || isInsideCwdTree(realCandidate))) ||
				!isWithinTrustedTargetRoot(realCandidate)
			) {
				continue
			}
			return candidate
		}
	}

	return null
}
