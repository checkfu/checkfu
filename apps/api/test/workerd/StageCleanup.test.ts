import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localD1File, removeStage } from "./StageCleanup.ts"

const dirs: Array<string> = []

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

const write = (root: string, path: string, content = "") => {
	mkdirSync(dirname(join(root, path)), { recursive: true })
	writeFileSync(join(root, path), content)
}

// What `alchemy dev` leaves for one stage with one Worker, as seen on a real run.
const stage = (
	root: string,
	name: string,
	workerName: string,
	databaseId: string,
): ReadonlyArray<string> => {
	write(
		root,
		`state/Checkfu/${name}/ListingDatabase.json`,
		JSON.stringify({
			logicalId: "ListingDatabase",
			resourceType: "Cloudflare.D1Database",
			attr: { databaseId },
		}),
	)
	const database = localD1File(databaseId)
	const gateway = `local/cache/alchemy-d1-gateway-${databaseId.replace(":", "-")}`
	for (const path of [database, `${database}-shm`, `${database}-wal`]) {
		write(root, `local/d1/cloudflare-runtime-D1DatabaseObject/${path}`)
	}
	write(root, `${gateway}/blob`)
	write(
		root,
		`state/Checkfu/${name}/ApiWorker.json`,
		JSON.stringify({
			logicalId: "ApiWorker",
			resourceType: "Cloudflare.Worker",
			attr: { workerName },
		}),
	)
	write(
		root,
		`state/Checkfu/${name}/Checkfu.DomainBackfill.json`,
		JSON.stringify({ logicalId: "Checkfu.DomainBackfill", resourceType: "Cloudflare.Workflow" }),
	)
	const left = [
		`bundles/Checkfu-${name}-ApiWorker/ApiWorker.js`,
		`local/cache/${workerName}/blob`,
		`local/${workerName}-Checkfu.SessionAggregate/metadata.sqlite`,
		`local/workflows/${workerName}-checkfu-doma-2159c24b/state`,
	]
	for (const path of left) {
		write(root, path)
	}
	return [
		`state/Checkfu/${name}`,
		`local/d1/cloudflare-runtime-D1DatabaseObject/${database}`,
		`local/d1/cloudflare-runtime-D1DatabaseObject/${database}-wal`,
		gateway,
		...left.map((path) => path.split("/").slice(0, -1).join("/")),
	]
}

describe("removing a local stage", () => {
	it("names a local D1 database's file as workerd does", () => {
		expect(localD1File("dev:3a201637-a57a-4169-ab9a-2ae735d8d3a4")).toBe(
			"ccf08b91265da79b9c69dca6a8892ae647e02ca6dba45a25566dd51e80dfc8bb.sqlite",
		)
	})

	it("removes the stage's Worker data and leaves a stage whose name starts with it", () => {
		const root = mkdtempSync(join(tmpdir(), "checkfu-alchemy-"))
		dirs.push(root)
		const removed = stage(
			root,
			"wd-a",
			"checkfu-apiworker-wd-a-bioatxeuafooaq6u",
			"dev:3a201637-a57a-4169-ab9a-2ae735d8d3a4",
		)
		const kept = stage(
			root,
			"wd-a-debug",
			"checkfu-apiworker-wd-a-debug-pvulsnfwd6s6iu2h",
			"dev:7d0e2b1c-5f3a-4e8b-9c6d-0a1b2c3d4e5f",
		)
		write(root, "log/run.ndjson")

		removeStage(root, "Checkfu", "wd-a")

		expect(removed.filter((path) => existsSync(join(root, path)))).toEqual([])
		expect(kept.filter((path) => !existsSync(join(root, path)))).toEqual([])
		expect(existsSync(join(root, "log/run.ndjson"))).toBe(true)
	})

	it("removes the bundles of a stage that stopped before writing its state, and no one else's", () => {
		const root = mkdtempSync(join(tmpdir(), "checkfu-alchemy-"))
		dirs.push(root)
		const bundles = ["bundles/Checkfu-wd-a-ApiWorker", "bundles/Checkfu-wd-a-McpWorker"]
		for (const bundle of bundles) {
			write(root, `${bundle}/Worker.js`)
		}
		const kept = stage(
			root,
			"wd-a-debug",
			"checkfu-apiworker-wd-a-debug-pvulsnfwd6s6iu2h",
			"dev:7d0e2b1c-5f3a-4e8b-9c6d-0a1b2c3d4e5f",
		)

		removeStage(root, "Checkfu", "wd-a")

		expect(bundles.filter((path) => existsSync(join(root, path)))).toEqual([])
		expect(kept.filter((path) => !existsSync(join(root, path)))).toEqual([])
	})
})
