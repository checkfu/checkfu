import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const cliRoot = fileURLToPath(new URL("..", import.meta.url))

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

describe.skipIf(process.platform === "win32")("the documented `bun checkfu` entry point", () => {
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
					scripts: {
						checkfu: `bun --no-env-file --config=${JSON.stringify(join(cliRoot, "bunfig.toml"))} ${JSON.stringify(join(cliRoot, "src", "main.ts"))}`,
					},
				}),
			)
			writeFileSync(
				join(project, ".env"),
				"CHECKFU_API_KEY=planted\nCHECKFU_URL=https://planted.example\n",
			)
			const call = spawnSync(
				"bun",
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
