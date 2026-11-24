import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseEnv } from "node:util"

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
 * Two shapes are accepted: no Bun flags at all in the checkout, after which
 * {@link dropCheckoutDotenv} removes what Bun loaded from the checkout's `.env` files,
 * or exactly `--no-env-file` with the CLI's bunfig from anywhere. Every Bun flag,
 * including one injected through `BUN_OPTIONS`, appears in `execArgv`, so anything
 * else, which could load another config or `.env` file, is refused.
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
	return undefined
}

/**
 * Removes from `env` every variable that Bun loaded from a `.env` file in `dir`, and
 * returns their names.
 *
 * `bun checkfu` runs in the checkout as one Bun process, so Bun has loaded the
 * checkout's `.env` files before any of this code. A key there belongs to the
 * checkout's deployment and must not count as exported. Bun keeps every variable that
 * was exported, so a variable whose value equals what one of those files defines came
 * from that file. One exported with the very same value is removed too, which is the
 * safe way to be wrong. Bun expands `$NAME` in these files and `parseEnv` does not, so a
 * variable whose file value contains `$` cannot be compared and is removed.
 */
export const dropCheckoutDotenv = (
	dir: string,
	env: Record<string, string | undefined>,
): ReadonlyArray<string> => {
	const dropped: Array<string> = []
	for (const file of readdirSync(dir).filter((name) => /^\.env(\..+)?$/.test(name))) {
		let defined: Readonly<Record<string, string | undefined>>
		try {
			defined = parseEnv(readFileSync(join(dir, file), "utf8"))
		} catch {
			continue
		}
		for (const [name, value] of Object.entries(defined)) {
			const current = env[name]
			if (
				value !== undefined &&
				current !== undefined &&
				(value.includes("$") || current === value)
			) {
				Reflect.deleteProperty(env, name)
				dropped.push(name)
			}
		}
	}
	return dropped
}
