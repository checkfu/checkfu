import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { alchemyDeployEnv } from "../src/Commands/Deploy.ts"
import type { Checkout } from "../src/Commands/Deploy.ts"

// Bun loads `.env.local` (among others) from the directory it starts in unless told not to.
// The deploy starts Alchemy with Bun in the checkout, so this runs a real Bun process the
// same way, in a folder whose files disagree with the jurisdiction the guard checked.
describe("the environment Alchemy deploys under", () => {
	it("keeps the checked jurisdiction over the files Bun loads in the checkout", () => {
		const checkout = mkdtempSync(join(tmpdir(), "checkfu-deploy-env-"))
		try {
			writeFileSync(join(checkout, ".env"), "CHECKFU_JURISDICTION=\n")
			writeFileSync(join(checkout, ".env.local"), "CHECKFU_JURISDICTION=eu\n")
			const probe = join(checkout, "probe.js")
			writeFileSync(
				probe,
				"console.log(JSON.stringify(process.env.CHECKFU_JURISDICTION ?? null))\n",
			)

			// Vitest sets NODE_ENV=test, under which Bun skips `.env.local`; a deploy runs without it.
			const { CHECKFU_JURISDICTION: _, NODE_ENV: __, ...shell } = process.env
			const jurisdictionIn = (env: Readonly<Record<string, string | undefined>>) => {
				const child = spawnSync("bun", [probe], { cwd: checkout, env, encoding: "utf8" })
				expect(child.status, child.stderr).toBe(0)
				return JSON.parse(child.stdout) as string | null
			}

			// Without the checked value, Bun would hand Alchemy the one from `.env.local`.
			expect(jurisdictionIn(shell)).toBe("eu")

			const settings: Checkout = {
				root: checkout,
				runtime: "bun",
				readyWithin: "1 second",
				runtimeEnv: {},
			}
			for (const checked of ["", "us"]) {
				expect(jurisdictionIn({ ...shell, ...alchemyDeployEnv(settings, checked) })).toBe(checked)
			}
		} finally {
			rmSync(checkout, { recursive: true, force: true })
		}
	})
})
