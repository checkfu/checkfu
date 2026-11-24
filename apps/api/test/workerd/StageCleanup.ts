import { readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const WorkerState = Schema.fromJsonString(
	Schema.Struct({
		resourceType: Schema.Literal("Cloudflare.Worker"),
		attr: Schema.Struct({ workerName: Schema.String }),
	}),
)

const list = (dir: string): ReadonlyArray<string> => {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

/**
 * Removes what a local `alchemy dev` stage left in `.alchemy`: its state, its Worker bundles, and
 * the local data of each Worker its state names. Bundles go even when the state was never
 * written; local data names come only from the state, so another stage keeps its data.
 */
export const removeStage = (alchemyDir: string, stack: string, stage: string): void => {
	const stateDir = join(alchemyDir, "state", stack, stage)
	const workers = list(stateDir).flatMap((file) =>
		Option.toArray(Schema.decodeOption(WorkerState)(readFileSync(join(stateDir, file), "utf8"))),
	)
	// A bundle is `<stack>-<stage>-<logical id>`, and no logical id in the stack has a hyphen, so
	// a hyphen after this stage's prefix means the bundle belongs to a stage whose name extends it.
	const bundlePrefix = `${stack}-${stage}-`
	for (const name of list(join(alchemyDir, "bundles"))) {
		if (name.startsWith(bundlePrefix) && !name.slice(bundlePrefix.length).includes("-")) {
			rmSync(join(alchemyDir, "bundles", name), { recursive: true, force: true })
		}
	}
	const owned = (name: string) =>
		workers.some(
			({ attr: { workerName } }) => name === workerName || name.startsWith(`${workerName}-`),
		)
	for (const subdir of ["local", join("local", "cache"), join("local", "workflows")]) {
		for (const name of list(join(alchemyDir, subdir)).filter(owned)) {
			rmSync(join(alchemyDir, subdir, name), { recursive: true, force: true })
		}
	}
	rmSync(stateDir, { recursive: true, force: true })
}
