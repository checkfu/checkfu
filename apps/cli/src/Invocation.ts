import { realpathSync } from "node:fs"
import { checkoutRoot } from "./Standalone.ts"

const resolved = (path: string): string | undefined => {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

export const invocation = (
	checkoutRoot: string | undefined,
	workingDirectory: string | undefined,
) => (checkoutRoot !== undefined && checkoutRoot === workingDirectory ? "bun checkfu" : "checkfu")

export const COMMAND = invocation(resolved(checkoutRoot), resolved("."))
