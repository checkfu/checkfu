import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { ALCHEMY_RUNTIME_FLAGS } from "../src/Commands/Deploy.ts"

// Bun loads `.env.local` (among others) from the directory it starts in unless told not to.
// The deploy starts Alchemy with Bun in the checkout, so this runs a real Bun process with the
// deploy's runtime flags in a folder whose `.env.local` sets a value.
describe("the Bun that runs Alchemy", () => {
	it("reads no environment file from the checkout on its own", () => {
		const checkout = mkdtempSync(join(tmpdir(), "checkfu-deploy-env-"))
		try {
			writeFileSync(join(checkout, ".env.local"), "CHECKFU_JURISDICTION=eu\n")
			const probe = join(checkout, "probe.js")
			writeFileSync(
				probe,
				"console.log(JSON.stringify(process.env.CHECKFU_JURISDICTION ?? null))\n",
			)

			// Vitest sets NODE_ENV=test, under which Bun skips `.env.local`; a deploy runs without it.
			const { CHECKFU_JURISDICTION: _, NODE_ENV: __, ...shell } = process.env
			const seen = (flags: ReadonlyArray<string>) => {
				const child = spawnSync("bun", [...flags, probe], {
					cwd: checkout,
					env: shell,
					encoding: "utf8",
				})
				expect(child.status, child.stderr).toBe(0)
				return JSON.parse(child.stdout) as string | null
			}

			expect(seen([])).toBe("eu")
			expect(seen(ALCHEMY_RUNTIME_FLAGS)).toBeNull()
		} finally {
			rmSync(checkout, { recursive: true, force: true })
		}
	})
})
