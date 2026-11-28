import { USAGE_EXIT_CODE } from "../src/Errors.ts"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { cliProcessEnv } from "./helpers/ProcessEnv.ts"

const cliRoot = fileURLToPath(new URL("..", import.meta.url))

describe.skipIf(process.platform === "win32")("the CLI started from another project", () => {
	it("gets nothing from that project's .env when a package script starts it with both flags", () => {
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
				"CHECKFU_API_KEY=planted\nCHECKFU_BASE_URL=https://planted.example\n",
			)
			const run = (args: ReadonlyArray<string>) =>
				spawnSync("bun", ["checkfu", ...args], {
					cwd: project,
					env: cliProcessEnv({ CHECKFU_CONFIG_DIR: join(project, "config") }),
					encoding: "utf8",
					timeout: 60_000,
				})
			const call = run([
				"--base-url",
				"https://another.example",
				"sessions",
				"retrieve",
				"--session-id",
				"s",
			])
			expect(call.status).toBe(USAGE_EXIT_CODE)
			expect(call.stderr).toContain("Missing CHECKFU_API_KEY")
			expect(call.stderr).not.toContain("planted")
			const login = run(["login"])
			expect(login.status).toBe(USAGE_EXIT_CODE)
			expect(login.stderr).toContain("Pass the deployment URL")
		} finally {
			rmSync(project, { recursive: true, force: true })
		}
	}, 120_000)
})
