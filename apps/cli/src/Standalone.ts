import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

declare const CHECKFU_STANDALONE: boolean | undefined

export const isStandalone: boolean = typeof CHECKFU_STANDALONE === "boolean" && CHECKFU_STANDALONE

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
