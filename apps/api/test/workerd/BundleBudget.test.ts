import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { measureBundle } from "./BundleBudget.ts"

const dirs: Array<string> = []
const bundle = (files: Record<string, string>): string => {
	const dir = mkdtempSync(join(tmpdir(), "checkfu-bundle-"))
	dirs.push(dir)
	for (const [name, source] of Object.entries(files)) {
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
		const files = {
			"Entry.js": [
				'import { DurableObject } from "cloudflare:workers"',
				'import { used } from "./used.js"',
				'console.log("printed while the module loads", used, DurableObject.name)',
				'export const text = `import "./mentioned.js"; export { a } from "./absent.js"`',
				'export const later = () => import("./later.js")',
			].join("\n"),
			"used.js": "export const used = 1",
			"later.js": "export const later = 2",
			"mentioned.js": "export const mentioned = 3",
		}
		const dir = bundle(files)
		const measured = await measureBundle(dir, "Entry.js")
		expect(measured.eagerFiles).toEqual(["Entry.js", "used.js"])
		expect(measured.eagerBytes).toBe(files["Entry.js"].length + files["used.js"].length)
		expect(measured.totalBytes).toBe(Object.values(files).join("").length)
		expect(measured.startupCpuMs).toBeGreaterThan(0)
	})

	it("kills a probe whose module scope never finishes", async () => {
		const dir = bundle({ "Entry.js": "while (true) {}" })
		await expect(measureBundle(dir, "Entry.js", 500)).rejects.toThrow("SIGKILL")
	})
})
