import { readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const WorkerState = Schema.fromJsonString(
	Schema.Struct({
		logicalId: Schema.String,
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
 * Removes what a local `alchemy dev` stage left in `.alchemy`: its state, and the bundle and
 * local data of each Worker that state names. Every name comes from the state, so another stage
 * whose name starts with this one keeps its data; a stage with no state left removes nothing.
 */
export const removeStage = (alchemyDir: string, stack: string, stage: string): void => {
	const stateDir = join(alchemyDir, "state", stack, stage)
	const workers = list(stateDir).flatMap((file) =>
		Option.toArray(Schema.decodeOption(WorkerState)(readFileSync(join(stateDir, file), "utf8"))),
	)
	for (const { logicalId } of workers) {
		rmSync(join(alchemyDir, "bundles", `${stack}-${stage}-${logicalId}`), {
			recursive: true,
			force: true,
		})
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
