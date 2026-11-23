declare const CHECKFU_STANDALONE: boolean | undefined

/**
 * True in the binary produced by `bun run build`, which is compiled with Bun's `.env`
 * and `bunfig.toml` autoloading switched off, so it needs no launcher to keep the
 * current directory from injecting configuration or code.
 */
export const isStandalone: boolean =
	// oxlint-disable-next-line unicorn/no-typeof-undefined -- the identifier exists only once the build defines it; comparing it directly would throw everywhere else
	typeof CHECKFU_STANDALONE !== "undefined" && CHECKFU_STANDALONE

/** How to invoke this CLI, for commands printed for the user to copy and run. */
export const COMMAND = isStandalone ? "checkfu" : "bun checkfu"
