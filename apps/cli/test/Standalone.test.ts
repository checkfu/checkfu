import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { resolveBunExecutable } from "../bin/resolve-bun.mjs"

const cliRoot = fileURLToPath(new URL("..", import.meta.url))
const binary = join(cliRoot, "dist", "checkfu")

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
		rmSync(binary, { force: true })
		const build = spawnSync(resolveBunExecutable() ?? "bun", ["run", "checkfu:build"], {
			cwd: join(cliRoot, "..", ".."),
			encoding: "utf8",
			timeout: 60_000,
		})
		expect(build.status, build.stderr).toBe(0)
		expect(existsSync(binary)).toBe(true)

		const hostile = mkdtempSync(join(tmpdir(), "checkfu-standalone-"))
		try {
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
				env: cleanEnv({ CHECKFU_CONFIG_DIR: join(hostile, "config") }),
				encoding: "utf8",
				timeout: 30_000,
			})
			expect(call.status).toBe(1)
			expect(call.stderr).toContain("Missing CHECKFU_API_KEY")
			expect(call.stderr).not.toContain("planted")
			expect(existsSync(join(hostile, "PRELOAD_RAN"))).toBe(false)

			const asBun = spawnSync(binary, ["--version"], {
				cwd: hostile,
				env: cleanEnv({ BUN_BE_BUN: "1" }),
				encoding: "utf8",
				timeout: 30_000,
			})
			expect(asBun.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
		} finally {
			rmSync(hostile, { recursive: true, force: true })
		}
	}, 120_000)

	it("gets nothing from the checkout's .env when started through the `bun checkfu` script", () => {
		// The documented entry point is a package script. Bun must not hand the script the
		// directory's .env, or a key meant for one deployment would count as exported and
		// be sent to whatever --base-url names.
		const project = mkdtempSync(join(tmpdir(), "checkfu-script-"))
		try {
			writeFileSync(
				join(project, "package.json"),
				JSON.stringify({
					name: "checkout",
					scripts: { checkfu: `node ${JSON.stringify(join(cliRoot, "bin", "checkfu.mjs"))}` },
				}),
			)
			writeFileSync(
				join(project, ".env"),
				"CHECKFU_API_KEY=planted\nCHECKFU_URL=https://planted.example\n",
			)
			const call = spawnSync(
				resolveBunExecutable() ?? "bun",
				[
					"checkfu",
					"--base-url",
					"https://another.example",
					"sessions",
					"retrieve",
					"--session-id",
					"s",
				],
				{
					cwd: project,
					env: cleanEnv({ CHECKFU_CONFIG_DIR: join(project, "config") }),
					encoding: "utf8",
					timeout: 60_000,
				},
			)
			expect(call.status).toBe(1)
			expect(call.stderr).toContain("Missing CHECKFU_API_KEY")
			expect(call.stderr).not.toContain("planted")
		} finally {
			rmSync(project, { recursive: true, force: true })
		}
	}, 120_000)
})
