import { realpathSync } from "node:fs"
import { checkoutRoot } from "./Standalone.ts"

const resolved = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/**
 * What to call this CLI in messages. Standing in the checkout it runs from, that is
 * the `bun checkfu` script the README uses; anywhere else it is just the program's
 * name, as in its help, and makes no claim about how it was started.
 */
export const invocation = (
	checkoutRoot: string | undefined,
	workingDirectory: string | undefined,
) => (checkoutRoot !== undefined && checkoutRoot === workingDirectory ? "bun checkfu" : "checkfu")

export const COMMAND = invocation(resolved(checkoutRoot), resolved("."))
