import { createHash, createHmac } from "node:crypto"
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

const D1State = Schema.fromJsonString(
	Schema.Struct({
		resourceType: Schema.Literal("Cloudflare.D1Database"),
		attr: Schema.Struct({ databaseId: Schema.String }),
	}),
)

const D1_OBJECTS = join("local", "d1", "cloudflare-runtime-D1DatabaseObject")

/** The file workerd keeps a local D1 database in: its Durable Object id for `getByName(databaseId)`. */
export const localD1File = (databaseId: string): string => {
	const key = createHash("sha256").update("cloudflare-runtime-D1DatabaseObject").digest()
	const name = createHmac("sha256", key).update(databaseId).digest().subarray(0, 16)
	const mac = createHmac("sha256", key).update(name).digest().subarray(0, 16)
	return `${Buffer.concat([name, mac]).toString("hex")}.sqlite`
}

const list = (dir: string): ReadonlyArray<string> => {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

/**
 * Removes what a local `alchemy dev` stage left in `.alchemy`: its state, its Worker bundles, and
 * the local data of each Worker and D1 database its state names. Bundles go even when the state was never
 * written; local data names come only from the state, so another stage keeps its data.
 */
export const removeStage = (alchemyDir: string, stack: string, stage: string): void => {
	const stateDir = join(alchemyDir, "state", stack, stage)
	const states = list(stateDir).map((file) => readFileSync(join(stateDir, file), "utf8"))
	const workers = states.flatMap((state) => Option.toArray(Schema.decodeOption(WorkerState)(state)))
	const databases = states.flatMap((state) => Option.toArray(Schema.decodeOption(D1State)(state)))
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
	for (const {
		attr: { databaseId },
	} of databases) {
		const file = localD1File(databaseId)
		for (const suffix of ["", "-shm", "-wal"]) {
			rmSync(join(alchemyDir, D1_OBJECTS, `${file}${suffix}`), { force: true })
		}
		const gateway = `alchemy-d1-gateway-${databaseId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`
		rmSync(join(alchemyDir, "local", "cache", gateway), { recursive: true, force: true })
	}
	rmSync(stateDir, { recursive: true, force: true })
}
