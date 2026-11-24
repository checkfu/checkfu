import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { Checkout } from "../src/Commands/Deploy.ts"
import { ALCHEMY_RUNTIME_FLAGS, jurisdictionBunWouldLoad } from "../src/Commands/Deploy.ts"

// The deploy starts Alchemy with Bun in the checkout. These run real Bun processes in a
// scratch folder, because which env files Bun loads is Bun's own behaviour.
const inScratch = async <A>(
	files: Record<string, string>,
	run: (dir: string) => A | Promise<A>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "checkfu-deploy-env-"))
	try {
		for (const [name, contents] of Object.entries(files)) {
			writeFileSync(join(dir, name), contents)
		}
		return await run(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// Vitest sets NODE_ENV=test, under which Bun skips `.env.local`; a deploy runs without it.
const { CHECKFU_JURISDICTION: _, NODE_ENV: __, ...shell } = process.env

const withShell = (env: Record<string, string | undefined>, run: () => Promise<string>) => {
	const saved = { ...process.env }
	for (const key of Object.keys(process.env)) {
		delete process.env[key]
	}
	Object.assign(process.env, shell, env)
	return run().finally(() => {
		for (const key of Object.keys(process.env)) {
			delete process.env[key]
		}
		Object.assign(process.env, saved)
	})
}

describe("the Bun that runs Alchemy", () => {
	it("reads no environment file from the checkout on its own", async () => {
		await inScratch({ ".env.local": "CHECKFU_JURISDICTION=eu\n" }, (dir) => {
			const probe = join(dir, "probe.js")
			writeFileSync(
				probe,
				"console.log(JSON.stringify(process.env.CHECKFU_JURISDICTION ?? null))\n",
			)
			const seen = (flags: ReadonlyArray<string>) => {
				const child = spawnSync("bun", [...flags, probe], {
					cwd: dir,
					env: shell,
					encoding: "utf8",
				})
				expect(child.status, child.stderr).toBe(0)
				return JSON.parse(child.stdout) as string | null
			}
			expect(seen([])).toBe("eu")
			expect(seen(ALCHEMY_RUNTIME_FLAGS)).toBeNull()
		})
	})
})

describe("the jurisdiction Bun would have loaded", () => {
	const loaded = (files: Record<string, string>, env: Record<string, string> = {}) =>
		inScratch({ ".env": "CHECKFU_JURISDICTION=\n", ...files }, (dir) => {
			const checkout: Checkout = {
				root: dir,
				runtime: "bun",
				readyWithin: "1 second",
				runtimeEnv: {},
			}
			return withShell(env, () =>
				Effect.runPromise(
					jurisdictionBunWouldLoad(checkout).pipe(Effect.provide(NodeServices.layer)),
				),
			)
		})

	it("follows Bun's own choice of env files, including mode-specific local ones", async () => {
		const eu = "CHECKFU_JURISDICTION=eu\n"
		expect(await loaded({})).toBe("")
		expect(await loaded({ ".env.local": eu })).toBe("eu")
		expect(await loaded({ ".env.development": eu })).toBe("eu")
		expect(await loaded({ ".env.development.local": eu })).toBe("eu")
		expect(await loaded({ ".env.production.local": eu }, { NODE_ENV: "production" })).toBe("eu")
		// Files Bun would not have loaded in that mode.
		expect(await loaded({ ".env.production": eu })).toBe("")
		expect(await loaded({ ".env.local": eu }, { NODE_ENV: "test" })).toBe("")
		// A value exported in the shell, even an empty one, is what Bun would have kept.
		expect(await loaded({ ".env.local": eu }, { CHECKFU_JURISDICTION: "" })).toBe("")
	})
})
