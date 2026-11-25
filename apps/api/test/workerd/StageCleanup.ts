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

const R2BucketState = Schema.fromJsonString(
	Schema.Struct({
		resourceType: Schema.Literal("Cloudflare.R2.Bucket"),
		attr: Schema.Struct({ bucketName: Schema.String }),
	}),
)

const D1_OBJECT = "cloudflare-runtime-D1DatabaseObject"
const R2_OBJECT = "cloudflare-runtime-R2BucketObject"

const localObjectFile = (namespace: string, name: string): string => {
	const key = createHash("sha256").update(namespace).digest()
	const id = createHmac("sha256", key).update(name).digest().subarray(0, 16)
	const mac = createHmac("sha256", key).update(id).digest().subarray(0, 16)
	return `${Buffer.concat([id, mac]).toString("hex")}.sqlite`
}

export const localD1File = (databaseId: string): string => localObjectFile(D1_OBJECT, databaseId)

export const localR2File = (bucketName: string): string => localObjectFile(R2_OBJECT, bucketName)

const removeObject = (dir: string, file: string) => {
	for (const suffix of ["", "-shm", "-wal"]) {
		rmSync(join(dir, `${file}${suffix}`), { force: true })
	}
}

const list = (dir: string): ReadonlyArray<string> => {
	try {
		return readdirSync(dir)
	} catch {
		return []
	}
}

export const removeStage = (alchemyDir: string, stack: string, stage: string): void => {
	const stateDir = join(alchemyDir, "state", stack, stage)
	const states = list(stateDir).map((file) => readFileSync(join(stateDir, file), "utf8"))
	const workers = states.flatMap((state) => Option.toArray(Schema.decodeOption(WorkerState)(state)))
	const databases = states.flatMap((state) => Option.toArray(Schema.decodeOption(D1State)(state)))
	const buckets = states.flatMap((state) =>
		Option.toArray(Schema.decodeOption(R2BucketState)(state)),
	)
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
		removeObject(join(alchemyDir, "local", "d1", D1_OBJECT), localD1File(databaseId))
		const gateway = `alchemy-d1-gateway-${databaseId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`
		rmSync(join(alchemyDir, "local", "cache", gateway), { recursive: true, force: true })
	}
	for (const {
		attr: { bucketName },
	} of buckets) {
		removeObject(join(alchemyDir, "local", "r2", R2_OBJECT), localR2File(bucketName))
		const blobs = bucketName.replaceAll(/[?<>*"'^/\\:|]/g, "_")
		rmSync(join(alchemyDir, "local", "r2", blobs), { recursive: true, force: true })
	}
	rmSync(stateDir, { recursive: true, force: true })
}
