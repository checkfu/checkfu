import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { resolveBunExecutable } from "../bin/resolve-bun.mjs"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))

interface ProcessEnv {
	[name: string]: string
}

const cleanEnv = (extra: ProcessEnv = {}): ProcessEnv => {
	const env: ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("CHECKFU_")) {
			env[key] = value
		}
	}
	return { ...env, ...extra }
}

describe.skipIf(process.platform === "win32")("standalone binary", () => {
	it("ignores .env and bunfig preloads in the current directory and can run as Bun", () => {
		const scratch = mkdtempSync(join(tmpdir(), "checkfu-standalone-"))
		try {
			// Built through the documented root script, into a scratch copy of the layout
			// (`<checkout>/apps/cli/dist/checkfu`) so a binary someone has already built in
			// the real `apps/cli/dist` is left alone.
			const checkout = join(scratch, "checkout")
			const binary = join(checkout, "apps", "cli", "dist", "checkfu")
			mkdirSync(join(checkout, "apps", "cli", "dist"), { recursive: true })
			const build = spawnSync(
				resolveBunExecutable() ?? "bun",
				["run", "checkfu:build", "--outfile", binary],
				{ cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
			)
			expect(build.status, build.stderr).toBe(0)
			expect(existsSync(binary)).toBe(true)

			const hostile = join(scratch, "hostile")
			mkdirSync(hostile)
			writeFileSync(
				join(hostile, ".env"),
				"CHECKFU_API_KEY=planted\nCHECKFU_URL=https://planted.example\n",
			)
			writeFileSync(join(hostile, "bunfig.toml"), 'preload = ["./preload.js"]\n')
			writeFileSync(
				join(hostile, "preload.js"),
				'require("node:fs").writeFileSync(__dirname + "/PRELOAD_RAN", "1")\n',
			)

			const call = spawnSync(binary, ["sessions", "retrieve", "--session-id", "sess_x"], {
				cwd: hostile,
				env: cleanEnv({ CHECKFU_CONFIG_DIR: join(scratch, "config") }),
				encoding: "utf8",
				timeout: 30_000,
			})
			expect(call.status).toBe(1)
			expect(call.stderr).toContain("Missing CHECKFU_API_KEY")
			expect(call.stderr).not.toContain("planted")
			expect(existsSync(join(hostile, "PRELOAD_RAN"))).toBe(false)

			// It names the checkout script only when standing in its own checkout. From `/`
			// a root worked out from the binary's virtual source path would wrongly match.
			for (const [cwd, name] of [
				[hostile, "checkfu"],
				["/", "checkfu"],
				[checkout, "bun checkfu"],
			] as const) {
				const hint = spawnSync(binary, ["sessions", "retrieve", "--session-id", "sess_x"], {
					cwd,
					env: cleanEnv({ CHECKFU_CONFIG_DIR: join(scratch, "config") }),
					encoding: "utf8",
					timeout: 30_000,
				})
				expect(hint.stderr).toContain(`Run \`${name} deploy\``)
			}

			const asBun = spawnSync(binary, ["--version"], {
				cwd: hostile,
				env: cleanEnv({ BUN_BE_BUN: "1" }),
				encoding: "utf8",
				timeout: 30_000,
			})
			expect(asBun.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
		} finally {
			rmSync(scratch, { recursive: true, force: true })
		}
	}, 120_000)
})
