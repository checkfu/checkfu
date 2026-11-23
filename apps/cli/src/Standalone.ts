import { fileURLToPath, pathToFileURL } from "node:url"

declare const CHECKFU_STANDALONE: boolean | undefined

/**
 * True in the binary produced by `bun run checkfu:build`. It is compiled with Bun's
 * `.env` and `bunfig.toml` autoloading switched off, so it needs no launcher to keep
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
