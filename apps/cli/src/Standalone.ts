import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

declare const CHECKFU_STANDALONE: boolean | undefined

/**
 * True in the binary produced by `bun run checkfu:build`. It is compiled with Bun's
 * `.env` and `bunfig.toml` autoloading switched off, so it needs no flags to keep
 * the current directory from injecting configuration or code.
 */
export const isStandalone: boolean =
	// oxlint-disable-next-line unicorn/no-typeof-undefined -- the identifier exists only once the build defines it; comparing it directly would throw everywhere else
	typeof CHECKFU_STANDALONE !== "undefined" && CHECKFU_STANDALONE

/**
 * The checkout this CLI belongs to. The binary is built into `apps/cli/dist`, so it
 * finds the checkout from its own path; its source lives in Bun's virtual filesystem.
 */
export const checkoutRoot: string = isStandalone
	? fileURLToPath(new URL("../../../", pathToFileURL(process.execPath)))
	: fileURLToPath(new URL("../../../", import.meta.url))

const physicalPath = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/**
 * Whether Bun started in a way that cannot have loaded a directory's `.env` or run its
 * `bunfig.toml` preloads. Every Bun flag, including one injected through `BUN_OPTIONS`,
 * appears in `execArgv`, so two exact shapes are accepted and nothing else:
 * no flags at all in the checkout, whose own bunfig switches `.env` loading off, or
 * exactly `--no-env-file` with the CLI's bunfig from anywhere.
 */
export const startedSafely = (
	execArgv: ReadonlyArray<string>,
	cwd: string,
	standalone: boolean = isStandalone,
): boolean => {
	if (standalone) {
		return true
	}
	if (execArgv.length === 0) {
		return physicalPath(cwd) === physicalPath(checkoutRoot)
	}
	const pinnedBunfig = physicalPath(join(checkoutRoot, "apps", "cli", "bunfig.toml"))
	return (
		execArgv.length === 2 &&
		pinnedBunfig !== undefined &&
		execArgv.includes("--no-env-file") &&
		execArgv.some(
			(arg) =>
				arg.startsWith("--config=") &&
				physicalPath(resolve(cwd, arg.slice("--config=".length))) === pinnedBunfig,
		)
	)
}
