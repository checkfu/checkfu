import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { dropCheckoutDotenv, startupRefusal } from "../src/Standalone.ts"

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
			const build = spawnSync("bun", ["run", "checkfu:build", "--outfile", binary], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 60_000,
			})
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
			const build = spawnSync("bun", ["run", "checkfu:build", "--outfile", binary], {
				cwd: repoRoot,
				encoding: "utf8",
				timeout: 60_000,
			})
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

describe("which ways of starting the CLI are accepted", () => {
	const elsewhere = tmpdir()
	const pinned = ["--no-env-file", `--config=${join(repoRoot, "apps", "cli", "bunfig.toml")}`]
	const refusal = (execArgv: ReadonlyArray<string>, cwd: string, checkout = repoRoot) =>
		startupRefusal(execArgv, cwd, { standalone: false, checkout })

	it("accepts no Bun flags in the checkout, and exactly the two pinned flags anywhere", () => {
		expect(refusal([], repoRoot)).toBeUndefined()
		expect(refusal(pinned, elsewhere)).toBeUndefined()
		expect(refusal([...pinned].reverse(), elsewhere)).toBeUndefined()
		expect(refusal(["--no-env-file", "--config=apps/cli/bunfig.toml"], repoRoot)).toBeUndefined()
		expect(startupRefusal(["--config=anything"], elsewhere, { standalone: true })).toBeUndefined()
	})

	it("refuses every other start, because any Bun flag can bring .env or a preload back", () => {
		for (const [execArgv, cwd] of [
			[[], elsewhere],
			[[], join(repoRoot, "apps", "cli")],
			[["--config=apps/cli/bunfig.toml"], repoRoot],
			[["--env-file=.env"], repoRoot],
			[["--env-file", ".env"], repoRoot],
			[["--preload", "./anything.ts"], repoRoot],
			[["--no-env-file"], repoRoot],
			[["--no-env-file"], elsewhere],
			[[pinned[1] ?? ""], elsewhere],
			[[...pinned, "--env-file=.env"], elsewhere],
			[[...pinned, "--preload", "./anything.ts"], elsewhere],
			[["--no-env-file", "--config=bunfig.toml"], repoRoot],
			[["--no-env-file", "--config=apps/cli/bunfig.toml"], elsewhere],
		] as const) {
			expect([execArgv, cwd, refusal(execArgv, cwd)]).toEqual([
				execArgv,
				cwd,
				expect.stringContaining("with no Bun flags"),
			])
		}
	})
})

describe("dropping what Bun loaded from the checkout's .env files", () => {
	const inDir = (files: Record<string, string>, run: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "checkfu-dotenv-"))
		try {
			for (const [name, content] of Object.entries(files)) {
				writeFileSync(join(dir, name), content)
			}
			run(dir)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}

	it("removes a variable whose value a .env file defines, and keeps every other", () => {
		inDir(
			{
				".env": "CHECKFU_API_KEY=from-file\nSHARED=file\nUNSET_HERE=x\n",
				".env.local": "CHECKFU_URL=https://local.example\n",
				".env.production": "CHECKFU_API_URL=https://prod.example\n",
				".env.example": "OPENAI_API_KEY=\n",
			},
			(dir) => {
				const env = {
					CHECKFU_API_KEY: "from-file",
					CHECKFU_URL: "https://local.example",
					CHECKFU_API_URL: "https://prod.example",
					SHARED: "exported-different",
					OPENAI_API_KEY: "sk-exported",
					PATH: "/usr/bin",
				}
				expect([...dropCheckoutDotenv(dir, env)].sort()).toEqual([
					"CHECKFU_API_KEY",
					"CHECKFU_API_URL",
					"CHECKFU_URL",
				])
				expect(env).toStrictEqual({
					SHARED: "exported-different",
					OPENAI_API_KEY: "sk-exported",
					PATH: "/usr/bin",
				})
			},
		)
	})

	it("follows the file that won when two define the same name", () => {
		inDir({ ".env": "CHECKFU_API_KEY=base\n", ".env.local": "CHECKFU_API_KEY=local\n" }, (dir) => {
			const env = { CHECKFU_API_KEY: "local" }
			dropCheckoutDotenv(dir, env)
			expect(env).toStrictEqual({})
		})
	})

	it("removes a variable whose file value Bun would expand, since it cannot be compared", () => {
		inDir({ ".env": "BASE=k\nCHECKFU_API_KEY=${BASE}-suffix\n" }, (dir) => {
			const env = {
				BASE: "k",
				CHECKFU_API_KEY: "k-suffix",
			}
			dropCheckoutDotenv(dir, env)
			expect(env).toStrictEqual({})
		})
	})

	it("ignores files that are not .env files and ones it cannot read", () => {
		inDir({ "env.txt": "CHECKFU_API_KEY=x\n", ".envrc": "CHECKFU_API_KEY=x\n" }, (dir) => {
			mkdirSync(join(dir, ".env.d"))
			const env = { CHECKFU_API_KEY: "x" }
			expect(dropCheckoutDotenv(dir, env)).toEqual([])
			expect(env).toStrictEqual({ CHECKFU_API_KEY: "x" })
		})
	})
})

describe.skipIf(process.platform === "win32")("`bun checkfu` in a checkout", () => {
	// A copy of the entry point, the CLI's source and the root bunfig, so .env files can be
	// planted without touching the real checkout.
	const copyCheckout = (): string => {
		const copy = mkdtempSync(join(tmpdir(), "checkfu-checkout-"))
		cpSync(join(repoRoot, "checkfu.ts"), join(copy, "checkfu.ts"))
		cpSync(join(repoRoot, "bunfig.toml"), join(copy, "bunfig.toml"))
		mkdirSync(join(copy, "apps", "cli"), { recursive: true })
		cpSync(join(repoRoot, "apps", "cli", "src"), join(copy, "apps", "cli", "src"), {
			recursive: true,
		})
		for (const file of ["package.json", "bunfig.toml"]) {
			cpSync(join(repoRoot, "apps", "cli", file), join(copy, "apps", "cli", file))
		}
		symlinkSync(join(repoRoot, "node_modules"), join(copy, "node_modules"), "dir")
		symlinkSync(
			join(repoRoot, "apps", "cli", "node_modules"),
			join(copy, "apps", "cli", "node_modules"),
			"dir",
		)
		return copy
	}

	const listen = async (handle: (authorization: string | undefined) => void) => {
		const server = createServer((request, response) => {
			handle(request.headers.authorization)
			response.writeHead(404, { "content-type": "application/json" })
			response.end(
				JSON.stringify({
					type: "error",
					error: { type: "not_found_error", message: "not found" },
					request_id: "req_test",
				}),
			)
		})
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		const address = server.address()
		const port = typeof address === "object" && address !== null ? address.port : 0
		return { server, url: `http://127.0.0.1:${port}` }
	}

	// Asynchronous, so the servers above can see a request while the CLI is running.
	const run = (cwd: string, env: ProcessEnv) =>
		new Promise<{ readonly status: number | null; readonly stderr: string }>((resolve, reject) => {
			const child = spawn("bun", ["checkfu", "sessions", "retrieve", "--session-id", "s"], {
				cwd,
				env,
				stdio: ["ignore", "ignore", "pipe"],
			})
			let stderr = ""
			child.stderr.setEncoding("utf8")
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk
			})
			child.on("error", reject)
			child.on("close", (status) => resolve({ status, stderr }))
		})

	it("never uses a key or URL from the checkout's .env files, and still uses exported ones", async () => {
		const planted: Array<string | undefined> = []
		const exported: Array<string | undefined> = []
		const plantedServer = await listen((authorization) => planted.push(authorization))
		const exportedServer = await listen((authorization) => exported.push(authorization))
		const checkout = copyCheckout()
		try {
			const dotenv = `CHECKFU_API_KEY=planted\nCHECKFU_API_URL=${plantedServer.url}\nCHECKFU_URL=${plantedServer.url}\n`
			for (const file of [".env", ".env.local", ".env.development", ".env.production"]) {
				writeFileSync(join(checkout, file), dotenv)
			}
			for (const nodeEnv of ["development", "production"]) {
				const base = cleanEnv({ CHECKFU_CONFIG_DIR: join(checkout, "config"), NODE_ENV: nodeEnv })

				const nothingExported = await run(checkout, base)
				expect(nothingExported.status).toBe(1)
				expect(nothingExported.stderr).toContain("Missing CHECKFU_API_KEY")

				const sameAsTheFile = await run(checkout, { ...base, CHECKFU_API_KEY: "planted" })
				expect(sameAsTheFile.status).toBe(1)
				expect(sameAsTheFile.stderr).toContain("with the same value as one there")

				const ownKey = await run(checkout, {
					...base,
					CHECKFU_API_KEY: "exported",
					CHECKFU_API_URL: exportedServer.url,
				})
				expect(ownKey.stderr).toContain("not_found_error")
			}
			expect(planted).toEqual([])
			expect(exported).toEqual(["Bearer exported", "Bearer exported"])

			// Bun itself still loads these files for everything else started in the checkout.
			const tool = spawnSync("bun", ["-e", "console.log(process.env.CHECKFU_API_KEY ?? 'unset')"], {
				cwd: checkout,
				env: cleanEnv(),
				encoding: "utf8",
				timeout: 20_000,
			})
			expect(tool.stdout.trim()).toBe("planted")
		} finally {
			rmSync(checkout, { recursive: true, force: true })
			for (const { server } of [plantedServer, exportedServer]) {
				server.closeAllConnections()
				server.close()
			}
		}
	}, 120_000)
})
