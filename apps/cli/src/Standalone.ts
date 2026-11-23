import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { shellQuote } from "./TerminalOutput.ts"

declare const CHECKFU_STANDALONE: boolean | undefined

/**
 * True in the binary produced by `bun run build`, which is compiled with Bun's `.env`
 * and `bunfig.toml` autoloading switched off, so it needs no launcher to keep the
 * current directory from injecting configuration or code.
 */
export const isStandalone: boolean =
	// oxlint-disable-next-line unicorn/no-typeof-undefined -- the identifier exists only once the build defines it; comparing it directly would throw everywhere else
	typeof CHECKFU_STANDALONE !== "undefined" && CHECKFU_STANDALONE

const resolved = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/**
 * How to run this same CLI again, for commands printed for the user to copy.
 *
 * `bun checkfu` means "the checkfu script of whatever checkout I am standing in", so
 * it is only offered when that checkout is the one this CLI is running from. Anywhere
 * else the command names this installation by absolute path, so a pasted command can
 * never run a different checkout's code.
 */
export const invocation = (context: {
	readonly standalone: boolean
	readonly executable: string
	readonly launcher: string
	readonly checkoutRoot: string | undefined
	readonly workingDirectory: string | undefined
}): string => {
	if (context.standalone) {
		return shellQuote(context.executable)
	}
	return context.checkoutRoot !== undefined && context.checkoutRoot === context.workingDirectory
		? "bun checkfu"
		: `node ${shellQuote(context.launcher)}`
}

export const COMMAND = invocation({
	standalone: isStandalone,
	executable: process.execPath,
	launcher: fileURLToPath(new URL("../bin/checkfu.mjs", import.meta.url)),
	checkoutRoot: resolved(fileURLToPath(new URL("../../../", import.meta.url))),
	workingDirectory: resolved("."),
})
