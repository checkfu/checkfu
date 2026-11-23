import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
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

	it("stops on an interrupt even when its parent holds an IPC channel", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "checkfu-standalone-"))
		// A server that accepts the request and never answers keeps the command pending.
		// Its first request is also the signal that the CLI is up and has its handlers
		// installed, so the interrupt is not sent into a process that is still starting.
		const server = createServer(() => undefined)
		const requested = once(server, "request")
		let child: ChildProcess | undefined
		// Everything started here is stopped in `finally`, whichever step fails.
		try {
			const binary = join(scratch, "checkfu")
			const build = spawnSync(
				resolveBunExecutable() ?? "bun",
				["run", "checkfu:build", "--outfile", binary],
				{ cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
			)
			expect(build.status, build.stderr).toBe(0)

			server.listen(0, "127.0.0.1")
			await once(server, "listening")
			const address = server.address()
			const port = typeof address === "object" && address !== null ? address.port : 0
			child = spawn(
				binary,
				["--base-url", `http://127.0.0.1:${port}`, "sessions", "retrieve", "--session-id", "s"],
				{
					stdio: ["ignore", "ignore", "ignore", "ipc"],
					env: cleanEnv({ CHECKFU_API_KEY: "key", CHECKFU_CONFIG_DIR: join(scratch, "config") }),
				},
			)
			const exited = once(child, "exit").then(([code]) => code as number | null)
			expect(await Promise.race([requested.then(() => "requested"), sleep(30_000)])).toBe(
				"requested",
			)
			child.kill("SIGINT")
			expect(await Promise.race([exited, sleep(5000).then(() => "still running")])).toBe(130)
		} finally {
			if (child !== undefined && child.exitCode === null && child.signalCode === null) {
				const gone = once(child, "exit")
				child.kill("SIGKILL")
				await gone
			}
			server.closeAllConnections()
			server.close()
			rmSync(scratch, { recursive: true, force: true })
		}
	}, 120_000)
})
