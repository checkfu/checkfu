import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs"
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

const MACHO_MAGICS = [
	[0xfe, 0xed, 0xfa, 0xce],
	[0xfe, 0xed, 0xfa, 0xcf],
	[0xce, 0xfa, 0xed, 0xfe],
	[0xcf, 0xfa, 0xed, 0xfe],
	[0xca, 0xfe, 0xba, 0xbe],
	[0xbe, 0xba, 0xfe, 0xca],
]

const isNativeBinaryHeader = (bytes, bytesRead, platform) => {
	if (platform === "win32") {
		return bytesRead >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a
	}
	if (bytesRead < 4) {
		return false
	}
	if (platform === "darwin") {
		return MACHO_MAGICS.some(
			(magic) =>
				bytes[0] === magic[0] &&
				bytes[1] === magic[1] &&
				bytes[2] === magic[2] &&
				bytes[3] === magic[3],
		)
	}
	// Linux / other POSIX ELF executable ("\x7fELF")
	return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
}

const defaultIsExecutableFile = (candidate, platform) => {
	let fd
	try {
		if (!statSync(candidate).isFile()) {
			return false
		}
		if (platform !== "win32") {
			accessSync(candidate, constants.X_OK)
		}
		fd = openSync(candidate, "r")
		const header = new Uint8Array(4)
		const bytesRead = readSync(fd, header, 0, 4, 0)
		return isNativeBinaryHeader(header, bytesRead, platform)
	} catch {
		return false
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// ignore close errors
			}
		}
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

	const isBroadAncestorDir = (dir) => {
		const resolved = pathModule.resolve(dir)
		if (homeKeys.has(canonicalKey(resolved)) || pathModule.dirname(resolved) === resolved) {
			return true
		}
		const realDir = safeRealpath(resolved)
		return (
			realDir !== undefined &&
			(homeKeys.has(canonicalKey(realDir)) || pathModule.dirname(realDir) === realDir)
		)
	}

	const isCwdBroadAncestor = isBroadAncestorDir(normalizedCwd)

	// Exclude version-manager shim directories that inspect cwd/project files
	// (such as .tool-versions, mise.toml, .prototools, or package.json) to pick
	// which executable to run. Concrete version-manager install directories
	// (e.g. ~/.asdf/installs, ~/.local/share/mise/installs, ~/.proto/tools) remain allowed.
	const projectSensitiveShimRootKeys = new Set()
	const addShimRoot = (dir) => {
		const resolved = isTrustedAbsolutePath(dir, platform, pathModule)
		if (resolved === undefined) {
			return
		}
		projectSensitiveShimRootKeys.add(canonicalKey(resolved))
		const realDir = safeRealpath(resolved)
		if (realDir !== undefined) {
			projectSensitiveShimRootKeys.add(canonicalKey(realDir))
		}
	}
	if (trustedHome !== undefined) {
		addShimRoot(pathModule.join(trustedHome, ".asdf", "shims"))
		addShimRoot(pathModule.join(trustedHome, ".local", "share", "mise", "shims"))
		addShimRoot(pathModule.join(trustedHome, ".proto", "shims"))
		addShimRoot(pathModule.join(trustedHome, ".volta", "bin"))
	}
	for (const { envVar, segments } of [
		{ envVar: "ASDF_DATA_DIR", segments: ["shims"] },
		{ envVar: "MISE_DATA_DIR", segments: ["shims"] },
		{ envVar: "XDG_DATA_HOME", segments: ["mise", "shims"] },
		{ envVar: "PROTO_HOME", segments: ["shims"] },
		{ envVar: "VOLTA_HOME", segments: ["bin"] },
	]) {
		const rawVal = getEnvValue(env, envVar, platform)
		if (rawVal !== undefined) {
			const base = isTrustedAbsolutePath(rawVal, platform, pathModule)
			if (base !== undefined) {
				addShimRoot(pathModule.join(base, ...segments))
			}
		}
	}
	if (platform === "win32") {
		const localAppData = getEnvValue(env, "LOCALAPPDATA", platform)
		if (localAppData !== undefined) {
			const ladDir = isTrustedAbsolutePath(localAppData, platform, pathModule)
			if (ladDir !== undefined) {
				addShimRoot(pathModule.join(ladDir, "mise", "shims"))
				addShimRoot(pathModule.join(ladDir, "Volta", "bin"))
			}
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

	const isProjectSensitiveShim = (target) => isWithinAnyRoot(target, projectSensitiveShimRootKeys)

	// Explicit operator override (`CHECKFU_BUN_PATH`): validated strictly and fail-closed
	// so misconfigured, shim, or checkout-local overrides never silently fall through.
	// Applies the same broad-ancestor exception as automatic discovery when cwd is $HOME or /.
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
			isProjectSensitiveShim(explicitPath) ||
			isProjectSensitiveShim(realExplicit) ||
			isExactWorkingDirectory(pathModule.dirname(explicitPath)) ||
			isExactWorkingDirectory(pathModule.dirname(realExplicit)) ||
			isInsideEnclosingCheckout(explicitPath) ||
			isInsideEnclosingCheckout(realExplicit) ||
			(!isCwdBroadAncestor && (isInsideCwdTree(explicitPath) || isInsideCwdTree(realExplicit)))
		) {
			return null
		}
		return explicitPath
	}

	// Explicitly trusted installation bin directories, dynamic versioned bin roots (e.g.
	// /nix/store, concrete mise/asdf/proto install trees, CI toolcaches), and symlink target roots.
	const trustedBinDirKeys = new Set()
	const trustedDynamicBinRootKeys = new Set()
	const trustedTargetRootKeys = new Set()
	const fallbackBinDirs = []

	const addTrustedTargetRoot = (rootDir) => {
		const resolvedRoot = isTrustedAbsolutePath(rootDir, platform, pathModule)
		if (
			resolvedRoot === undefined ||
			isBroadAncestorDir(resolvedRoot) ||
			hasNodeModulesSegment(resolvedRoot, platform) ||
			isProjectSensitiveShim(resolvedRoot) ||
			isInsideEnclosingCheckout(resolvedRoot)
		) {
			return undefined
		}
		trustedTargetRootKeys.add(canonicalKey(resolvedRoot))
		const realRoot = safeRealpath(resolvedRoot)
		if (
			realRoot !== undefined &&
			!isBroadAncestorDir(realRoot) &&
			!hasNodeModulesSegment(realRoot, platform) &&
			!isProjectSensitiveShim(realRoot) &&
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
			!isProjectSensitiveShim(realRoot) &&
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
			isProjectSensitiveShim(resolvedBin) ||
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
			!isProjectSensitiveShim(realBin) &&
			!isExactWorkingDirectory(realBin) &&
			!isInsideEnclosingCheckout(realBin)
		) {
			trustedBinDirKeys.add(canonicalKey(realBin))
		}
		fallbackBinDirs.push(resolvedBin)
	}

	const defaultUserBunRoot =
		trustedHome !== undefined ? pathModule.join(trustedHome, ".bun") : undefined

	// Trust BUN_INSTALL only when absolute, without node_modules or shim dirs, and outside
	// the enclosing checkout (applying the broad-ancestor exception when cwd is $HOME or /).
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
			!isProjectSensitiveShim(bunInstallDir) &&
			!isExactWorkingDirectory(bunInstallDir) &&
			!isInsideEnclosingCheckout(bunInstallDir) &&
			(isCwdBroadAncestor || isDefaultUserBun || !isInsideCwdTree(bunInstallDir))
		) {
			registerTrustedInstall(pathModule.join(bunInstallDir, "bin"), bunInstallDir)
		}
	}

	// Hosted CI toolcaches (e.g. GitHub Actions RUNNER_TOOL_CACHE) when outside checkout
	for (const toolCacheEnv of ["RUNNER_TOOL_CACHE", "AGENT_TOOLSDIRECTORY"]) {
		const rawCache = getEnvValue(env, toolCacheEnv, platform)
		if (rawCache !== undefined) {
			const cacheDir = isTrustedAbsolutePath(rawCache, platform, pathModule)
			if (
				cacheDir !== undefined &&
				!hasNodeModulesSegment(cacheDir, platform) &&
				!isProjectSensitiveShim(cacheDir) &&
				!isInsideEnclosingCheckout(cacheDir) &&
				(isCwdBroadAncestor || !isInsideCwdTree(cacheDir))
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
			const scoopBunCurrent = pathModule.join(trustedHome, "scoop", "apps", "bun", "current")
			registerTrustedInstall(scoopBunCurrent, pathModule.join(trustedHome, "scoop", "apps", "bun"))
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
			// Only concrete version-manager install directories — never cwd-reading shim dirs
			addTrustedDynamicBinRoot(pathModule.join(trustedHome, ".local", "share", "mise", "installs"))
			addTrustedDynamicBinRoot(pathModule.join(trustedHome, ".asdf", "installs"))
			addTrustedDynamicBinRoot(pathModule.join(trustedHome, ".proto", "tools"))
			const localBin = pathModule.join(trustedHome, ".local", "bin")
			registerTrustedInstall(localBin, localBin)
		}
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

	const candidateDirs = []
	const seenDirs = new Set()
	const addTrustedCandidateDir = (rawDir) => {
		const resolved = isTrustedAbsolutePath(rawDir, platform, pathModule)
		if (
			resolved === undefined ||
			hasNodeModulesSegment(resolved, platform) ||
			isProjectSensitiveShim(resolved) ||
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
				isProjectSensitiveShim(candidate) ||
				isProjectSensitiveShim(realCandidate) ||
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
