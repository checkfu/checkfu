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
 * Why this start is refused, or `undefined` when it is accepted.
 *
 * Bun loads `.env` files and `bunfig.toml` preloads from the directory it starts in, so
 * the only accepted start is the `checkfu` package script's: exactly `--no-env-file`
 * with the CLI's bunfig. Every Bun flag, including one injected through `BUN_OPTIONS`,
 * appears in `execArgv`, so a start with anything else, or with nothing, is refused.
 * The standalone binary is compiled with both switched off and needs no flags.
 */
export const startupRefusal = (
	execArgv: ReadonlyArray<string>,
	cwd: string,
	options?: { readonly standalone?: boolean; readonly checkout?: string },
): string | undefined => {
	if (options?.standalone ?? isStandalone) {
		return undefined
	}
	const pinnedBunfig = physicalPath(
		join(options?.checkout ?? checkoutRoot, "apps", "cli", "bunfig.toml"),
	)
	const pinned =
		execArgv.length === 2 &&
		pinnedBunfig !== undefined &&
		execArgv.includes("--no-env-file") &&
		execArgv.some(
			(arg) =>
				arg.startsWith("--config=") &&
				physicalPath(resolve(cwd, arg.slice("--config=".length))) === pinnedBunfig,
		)
	return pinned
		? undefined
		: "Run the CLI with `bun checkfu` from the Checkfu checkout, which starts Bun with `--no-env-file` and the CLI's own bunfig and nothing else. From any other directory, build the standalone binary with `bun run checkfu:build` and call it by its path."
}
