import { readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Toml from "effect/encoding/Toml"
import * as Result from "effect/Result"

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

const disablesDotenv = (bunfigPath: string): boolean => {
	try {
		const bunfig = Toml.parse(readFileSync(bunfigPath, "utf8"))
		return Result.isSuccess(bunfig) && bunfig.success["env"] === false
	} catch {
		return false
	}
}

/**
 * Why this start is refused, or `undefined` when it is accepted.
 *
 * Bun loads `.env` and `bunfig.toml` from the directory it starts in. Two exact shapes
 * cannot have loaded a key that was never exported: no Bun flags at all in the checkout,
 * whose own bunfig must switch `.env` loading off, or exactly `--no-env-file` with the
 * CLI's bunfig from anywhere. Every Bun flag, including one injected through
 * `BUN_OPTIONS`, appears in `execArgv`, so anything else is refused.
 *
 * This guards against mistakes. It cannot guard against a hostile directory: Bun runs
 * that directory's preloads before this code. The standalone binary is for that.
 */
export const startupRefusal = (
	execArgv: ReadonlyArray<string>,
	cwd: string,
	options?: { readonly standalone?: boolean; readonly checkout?: string },
): string | undefined => {
	if (options?.standalone ?? isStandalone) {
		return undefined
	}
	const checkout = options?.checkout ?? checkoutRoot
	const pinnedBunfig = physicalPath(join(checkout, "apps", "cli", "bunfig.toml"))
	if (
		execArgv.length === 2 &&
		pinnedBunfig !== undefined &&
		execArgv.includes("--no-env-file") &&
		execArgv.some(
			(arg) =>
				arg.startsWith("--config=") &&
				physicalPath(resolve(cwd, arg.slice("--config=".length))) === pinnedBunfig,
		)
	) {
		return undefined
	}
	if (execArgv.length > 0 || physicalPath(cwd) !== physicalPath(checkout)) {
		return "Run `bun checkfu` from the Checkfu checkout, with no Bun flags. From any other directory, build the standalone binary with `bun run checkfu:build` and call it by its path."
	}
	if (!disablesDotenv(join(checkout, "bunfig.toml"))) {
		return "The checkout's bunfig.toml must contain `env = false`, so that keys in the checkout's .env are not loaded as if they had been exported. Restore that line and run again."
	}
	return undefined
}
