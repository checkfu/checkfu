import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { removeStage } from "./StageCleanup.ts"

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
const stage = (root: string, name: string, workerName: string): ReadonlyArray<string> => {
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
	return [`state/Checkfu/${name}`, ...left.map((path) => path.split("/").slice(0, -1).join("/"))]
}

describe("removing a local stage", () => {
	it("removes the stage's Worker data and leaves a stage whose name starts with it", () => {
		const root = mkdtempSync(join(tmpdir(), "checkfu-alchemy-"))
		dirs.push(root)
		const removed = stage(root, "wd-a", "checkfu-apiworker-wd-a-bioatxeuafooaq6u")
		const kept = stage(root, "wd-a-debug", "checkfu-apiworker-wd-a-debug-pvulsnfwd6s6iu2h")
		write(root, "log/run.ndjson")

		removeStage(root, "Checkfu", "wd-a")

		expect(removed.filter((path) => existsSync(join(root, path)))).toEqual([])
		expect(kept.filter((path) => !existsSync(join(root, path)))).toEqual([])
		expect(existsSync(join(root, "log/run.ndjson"))).toBe(true)
	})

	it("removes nothing for a stage whose state is gone", () => {
		const root = mkdtempSync(join(tmpdir(), "checkfu-alchemy-"))
		dirs.push(root)
		const kept = stage(root, "wd-a-debug", "checkfu-apiworker-wd-a-debug-pvulsnfwd6s6iu2h")

		removeStage(root, "Checkfu", "wd-a")

		expect(kept.filter((path) => !existsSync(join(root, path)))).toEqual([])
	})
})
