import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { measureBundle } from "./BundleBudget.ts"

const dirs: Array<string> = []
const bundle = (files: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), "checkfu-bundle-"))
	dirs.push(dir)
	for (const [name, source] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), source)
	}
	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("bundle measurement", () => {
	it("counts the modules the entry really loads, whatever the entry prints or mentions", async () => {
		const shipped = {
			"Entry.js": [
				'import { DurableObject } from "cloudflare:workers"',
				'import { used } from "./chunks/used.js"',
				'console.log("printed while the module loads", used, DurableObject.name)',
				'export const text = `import "./mentioned.js"; export { a } from "./absent.js"`',
				'export const later = () => import("./chunks/deep/later.js")',
			].join("\n"),
			"chunks/used.js": "export const used = 1",
			"chunks/deep/later.js": "export const later = 2",
			"mentioned.js": "export const mentioned = 3",
		}
		const harness = "../../node_modules/openai/index.mjs"
		const dir = bundle({
			...shipped,
			"Entry.js.map": JSON.stringify({ sources: ["../../apps/api/src/ApiWorker.ts"] }),
			"chunks/deep/later.js.map": JSON.stringify({ sources: [harness] }),
		})
		const measured = await measureBundle(dir, "Entry.js")
		expect(measured.eagerFiles).toEqual(["Entry.js", join("chunks", "used.js")])
		expect(measured.eagerBytes).toBe(shipped["Entry.js"].length + shipped["chunks/used.js"].length)
		expect(measured.totalBytes).toBe(Object.values(shipped).join("").length)
		expect(measured.startupCpuMs).toBeGreaterThan(0)
		expect(measured.harnessSources).toEqual([harness])
	})

	it("measures an entry that leaves a timer running", async () => {
		const dir = bundle({ "Entry.js": "setInterval(() => {}, 1000)" })
		const measured = await measureBundle(dir, "Entry.js", 5000)
		expect(measured.eagerFiles).toEqual(["Entry.js"])
	})

	it("imports cold in plain Node whatever compile cache and options the caller set", async () => {
		const dir = bundle({
			"Entry.js": [
				'import { getCompileCacheDir } from "node:module"',
				'if (getCompileCacheDir() !== undefined) throw new Error("The compile cache is on")',
			].join("\n"),
		})
		const saved = { cache: process.env.NODE_COMPILE_CACHE, options: process.env.NODE_OPTIONS }
		process.env.NODE_COMPILE_CACHE = join(dir, "cache")
		process.env.NODE_OPTIONS = `--require ${join(dir, "absent.cjs")}`
		try {
			expect((await measureBundle(dir, "Entry.js")).eagerFiles).toEqual(["Entry.js"])
		} finally {
			for (const [name, value] of [
				["NODE_COMPILE_CACHE", saved.cache],
				["NODE_OPTIONS", saved.options],
			] as const) {
				if (value === undefined) {
					delete process.env[name]
				} else {
					process.env[name] = value
				}
			}
		}
	})

	it("kills a probe whose module scope never finishes", async () => {
		const dir = bundle({ "Entry.js": "while (true) {}" })
		await expect(measureBundle(dir, "Entry.js", 500)).rejects.toThrow("SIGKILL")
	})
	it("names the largest sources of the eager code from the source maps", async () => {
		const source = 'export const a = "€€";'
		const dir = bundle({
			"Entry.js": source,
			"Entry.js.map": JSON.stringify({
				version: 3,
				sources: [
					"../../node_modules/.bun/pkg@1/node_modules/pkg/index.js",
					"../../apps/api/src/a.ts",
				],
				mappings: "AAAA,I,ICAA",
			}),
		})
		const measured = await measureBundle(dir, "Entry.js")
		expect(measured.eagerContributors).toEqual([
			{ source: "apps/api/src/a.ts", bytes: source.length - 8 + 4 },
			{ source: "pkg", bytes: 4 },
		])
	})
})
