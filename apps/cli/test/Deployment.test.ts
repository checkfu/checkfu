import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { packTar } from "modern-tar"
import { afterEach, describe, expect, it } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as ConfigProvider from "effect/ConfigProvider"
import { extract, installRuntime, makeGithubDistribution } from "../src/Deployment/Distribution.ts"
import type { Distribution } from "../src/Deployment/Distribution.ts"
import {
	acquireOperation,
	managedEnvironment,
	prepareManaged,
	makeManagedResolver,
} from "../src/Deployment/Managed.ts"

const first = "a".repeat(40)
const second = "b".repeat(40)
const signal = () => new AbortController().signal
const directories: Array<string> = []
const temporary = async () => {
	const root = await mkdtemp(join(tmpdir(), "checkfu-deployment-"))
	directories.push(root)
	return root
}
afterEach(async () => {
	for (const root of directories.splice(0)) {
		await rm(root, { recursive: true, force: true })
	}
})

const archive = async (files: Record<string, string>) =>
	gzipSync(
		await packTar(
			Object.entries(files).map(([name, body]) => ({
				header: { name: `package/${name}`, type: "file" as const, size: Buffer.byteLength(body) },
				body,
			})),
		),
	)

const fixture = async () => {
	const runtime = await archive({ "bin/bun": "verified runtime" })
	const runtimeSpec = {
		version: "1.4.2",
		targets: {
			"darwin-arm64": {
				url: "https://registry.npmjs.org/@oven/runtime.tgz",
				integrity: `sha512-${createHash("sha512").update(runtime).digest("base64")}`,
			},
		},
	}
	const source = await archive({
		"checkfu.deployment.json": JSON.stringify({ protocol: 1, runtime: runtimeSpec }),
		"alchemy.run.ts": "export default 'production stack'",
		"bun.lock": "frozen dependencies",
		"apps/api/test/persisted/Persisted.lock.json": "shipped baseline",
	})
	const forced: Array<boolean> = []
	const calls: Array<string> = []
	let revision = first
	const distribution: Distribution = {
		latest: async () => {
			calls.push("main")
			return revision
		},
		source: async (sha) => {
			calls.push(`source:${sha}`)
			return source
		},
		download: async () => {
			calls.push("runtime")
			return runtime
		},
	}
	return {
		calls,
		forced,
		source,
		runtimeSpec,
		distribution,
		next: () => {
			revision = second
		},
		options: {
			distribution,
			target: "darwin-arm64",
			env: {},
			announce: () => {},
			install: async (
				_runtime: string,
				root: string,
				_env: NodeJS.ProcessEnv,
				_signal: AbortSignal,
				force = false,
			) => {
				calls.push("install")
				forced.push(force)
				const bin = join(root, "node_modules", "alchemy", "bin")
				await mkdir(bin, { recursive: true })
				await writeFile(join(bin, "cli.js"), "")
			},
		},
	}
}

describe("managed deployment lifecycle", () => {
	it("explains an incompatible server protocol before downloading or executing its runtime", async () => {
		const directory = await temporary()
		const f = await fixture()
		const source = await archive({
			"checkfu.deployment.json": JSON.stringify({ protocol: 2, runtime: f.runtimeSpec }),
			"alchemy.run.ts": "",
			"bun.lock": "",
		})
		await expect(
			prepareManaged(
				directory,
				{ operation: "deploy" },
				{
					...f.options,
					distribution: { ...f.distribution, source: async () => source },
				},
				signal(),
			),
		).rejects.toThrow("npm install -g checkfu@latest")
		expect(f.calls).toEqual(["main"])
	})
	it("holds the operation lock until cancellation has finished asynchronous cleanup", async () => {
		const directory = await temporary()
		const f = await fixture()
		const started = Promise.withResolvers<void>()
		const aborted = Promise.withResolvers<void>()
		const cleanup = Promise.withResolvers<void>()
		let cleaned = false
		const resolver = makeManagedResolver({
			...f.options,
			distribution: {
				...f.distribution,
				source: async (_revision, signal) => {
					started.resolve()
					try {
						await new Promise<void>((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => {
									aborted.resolve()
									reject(new Error("cancelled"))
								},
								{ once: true },
							)
						})
						return f.source
					} finally {
						await cleanup.promise
						cleaned = true
					}
				},
			},
		})
		const fiber = Effect.runFork(
			resolver({ operation: "deploy" }).pipe(
				Effect.scoped,
				Effect.provide([
					NodeServices.layer,
					ConfigProvider.layer(ConfigProvider.fromUnknown({ CHECKFU_CONFIG_DIR: directory })),
				]),
			),
		)
		await started.promise
		const completion = Effect.runPromise(Fiber.interrupt(fiber))
		try {
			await aborted.promise
			const state = await Promise.race([
				completion.then(() => "released"),
				new Promise<string>((resolve) => {
					setTimeout(() => resolve("held"), 100)
				}),
			])
			expect(state).toBe("held")
			await expect(acquireOperation(join(directory, "deploy"))).rejects.toThrow(
				"Another Checkfu deployment operation",
			)
		} finally {
			cleanup.resolve()
			await completion
		}
		expect(cleaned).toBe(true)
		await (
			await acquireOperation(join(directory, "deploy"))
		)()
	})
	it("installs once, follows main, and preserves stage secrets/data across updates, failures and reinstalls", async () => {
		const directory = await temporary()
		const f = await fixture()
		const installed = await prepareManaged(
			directory,
			{ operation: "deploy", stage: "staging" },
			f.options,
			signal(),
		)
		await installed.record()
		await writeFile(
			join(installed.dataRoot, ".env"),
			"CHECKFU_API_KEY=stable\nOPENAI_API_KEY=private",
			{ mode: 0o600 },
		)
		await writeFile(join(installed.dataRoot, "domain-data"), "must survive")
		const repeated = await prepareManaged(directory, { operation: "deploy" }, f.options, signal())
		expect(repeated.root).toBe(installed.root)
		expect(repeated.stage).toBe("staging")
		expect(f.calls).toEqual(["main", `source:${first}`, "runtime", "install", "main"])
		f.next()
		const updated = await prepareManaged(directory, { operation: "deploy" }, f.options, signal())
		expect(updated.root).not.toBe(installed.root)
		expect(updated.dataRoot).toBe(installed.dataRoot)
		await updated.record() // This must be done before the cloud mutation, even if that mutation fails.
		await expect(readFile(join(updated.dataRoot, ".env"), "utf8")).resolves.toContain(
			"CHECKFU_API_KEY=stable",
		)
		await expect(readFile(join(updated.dataRoot, "domain-data"), "utf8")).resolves.toBe(
			"must survive",
		)
		const lastCalls = f.calls.slice()
		const destroy = await prepareManaged(
			directory,
			{ operation: "destroy", stage: "staging" },
			f.options,
			signal(),
		)
		expect(destroy.revision).toBe(second)
		expect(f.calls).toEqual(lastCalls) // Destroy uses recorded source; no main/GitHub dependency.
		expect((await stat(join(directory, "deploy", "active.json"))).mode & 0o777).toBe(0o600)
		await writeFile(join(updated.root, "alchemy.run.ts"), "tampered")
		await prepareManaged(directory, { operation: "deploy" }, f.options, signal())
		expect(f.calls.filter((call) => call === `source:${second}`)).toHaveLength(2)
		await expect(readFile(join(updated.dataRoot, "domain-data"), "utf8")).resolves.toBe(
			"must survive",
		)
	})

	it("isolates stages and refuses unknown or implicit destruction before downloads", async () => {
		const directory = await temporary()
		const f = await fixture()
		for (const request of [
			{ operation: "destroy" as const },
			{ operation: "destroy" as const, stage: "other" },
		]) {
			await expect(prepareManaged(directory, request, f.options, signal())).rejects.toThrow(
				/Name the stage|no record/,
			)
		}
		expect(f.calls).toEqual([])
		const live = await prepareManaged(
			directory,
			{ operation: "deploy", stage: "live" },
			f.options,
			signal(),
		)
		const staging = await prepareManaged(
			directory,
			{ operation: "deploy", stage: "staging" },
			f.options,
			signal(),
		)
		expect(live.dataRoot).not.toBe(staging.dataRoot)
		expect(live.root).toBe(staging.root)
		await expect(
			prepareManaged(directory, { operation: "deploy", stage: "../live" }, f.options, signal()),
		).rejects.toThrow("Invalid deployment stage")
	})

	it("repairs missing dependencies without fetching recorded source or disturbing stage data", async () => {
		const directory = await temporary()
		const f = await fixture()
		const deploy = { operation: "deploy" as const, stage: "staging" }
		const ready = await prepareManaged(directory, deploy, f.options, signal())
		await ready.record()
		const marker = join(ready.root, ".checkfu", "installed")
		const modules = join(ready.root, "node_modules")
		const entry = join(modules, "alchemy", "bin", "cli.js")
		await rm(entry)
		await expect(
			prepareManaged(directory, deploy, { ...f.options, install: async () => {} }, signal()),
		).rejects.toThrow("Alchemy CLI")
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
		await prepareManaged(directory, deploy, f.options, signal())
		await rm(modules, { recursive: true })
		f.next()
		const repaired = await prepareManaged(
			directory,
			{ operation: "destroy", stage: "staging" },
			f.options,
			signal(),
		)
		expect(repaired.revision).toBe(first)
		expect(repaired.dataRoot).toBe(ready.dataRoot)
		expect((await stat(entry)).isFile()).toBe(true)
		expect(await readFile(marker, "utf8")).toBe("1\n")
		expect(f.calls.filter((call) => call.startsWith("source:"))).toEqual([`source:${first}`])
		expect(f.calls.filter((call) => call === "install")).toHaveLength(3)
		expect(f.forced).toEqual([false, true, false])
	})

	it("recovers an interrupted install and never marks failed dependencies installed", async () => {
		const directory = await temporary()
		const f = await fixture()
		await expect(
			prepareManaged(
				directory,
				{ operation: "deploy" },
				{
					...f.options,
					install: async () => {
						throw new Error("interrupted install")
					},
				},
				signal(),
			),
		).rejects.toThrow("interrupted install")
		const ready = await prepareManaged(directory, { operation: "deploy" }, f.options, signal())
		await expect(readFile(join(ready.root, ".checkfu", "installed"), "utf8")).resolves.toBe("1\n")
		expect(f.calls.filter((call) => call.startsWith("source:"))).toHaveLength(1)
		expect(f.calls.filter((call) => call === "install")).toHaveLength(1)
	})

	it("excludes overlapping operations and releases ownership after completion", async () => {
		const directory = await temporary()
		const release = await acquireOperation(directory)
		await expect(acquireOperation(directory)).rejects.toThrow(
			"Another Checkfu deployment operation",
		)
		await release()
		await (
			await acquireOperation(directory)
		)()
		expect(
			managedEnvironment({
				BUN_OPTIONS: "--preload evil",
				NODE_OPTIONS: "--import evil",
				OPENAI_API_KEY: "keep",
				PATH: "/usr/bin",
			}),
		).toEqual({ OPENAI_API_KEY: "keep", PATH: "/usr/bin" })
	})
})

describe("deployment downloads", () => {
	it("fetches the latest main commit once per deployment without consulting or waiting for CI", async () => {
		const calls: Array<string> = []
		const distribution = makeGithubDistribution(async (input) => {
			const url = String(input)
			calls.push(url)
			expect(url).toBe("https://api.github.com/repos/checkfu/checkfu/commits/main")
			return Response.json({ sha: calls.length === 1 ? first : second })
		})
		await expect(distribution.latest(signal())).resolves.toBe(first)
		await expect(distribution.latest(signal())).resolves.toBe(second)
		expect(calls).toHaveLength(2)
	})
	it("refuses an invalid revision or a failed source lookup before downloading code", async () => {
		await expect(
			makeGithubDistribution(async () => Response.json({ sha: "not-a-commit" })).latest(signal()),
		).rejects.toThrow("invalid main revision")
		await expect(
			makeGithubDistribution(async () => new Response(null, { status: 403 })).latest(signal()),
		).rejects.toThrow("GitHub HTTP 403")
	})
	it("verifies runtime integrity before executing, detects cache corruption and can retry", async () => {
		const directory = await temporary()
		const f = await fixture()
		await expect(
			installRuntime(
				directory,
				f.runtimeSpec,
				"darwin-arm64",
				{
					...f.distribution,
					download: async () => new TextEncoder().encode("untrusted bytes"),
				},
				signal(),
			),
		).rejects.toThrow("integrity check")
		const binary = await installRuntime(
			directory,
			f.runtimeSpec,
			"darwin-arm64",
			f.distribution,
			signal(),
		)
		await expect(readFile(binary, "utf8")).resolves.toBe("verified runtime")
		expect((await stat(binary)).mode & 0o777).toBe(0o700)
		await writeFile(binary, "tampered")
		await installRuntime(directory, f.runtimeSpec, "darwin-arm64", f.distribution, signal())
		await expect(readFile(binary, "utf8")).resolves.toBe("verified runtime")
		await expect(
			installRuntime(directory, f.runtimeSpec, "win32-x64", f.distribution, signal()),
		).rejects.toThrow("does not support")
	})

	it.each([
		"../outside",
		"/absolute",
		"package/../../outside",
		String.raw`package/a\b`,
		"package/C:drive",
	])("rejects unsafe source entry %s", async (name) => {
		const directory = await temporary()
		const tar = await packTar([{ header: { name, type: "file", size: 4 }, body: "evil" }])
		await expect(extract(gzipSync(tar), directory)).rejects.toThrow()
	})

	it("rejects links and duplicate files instead of following them", async () => {
		const directory = await temporary()
		for (const tar of [
			await packTar([
				{ header: { name: "package/link", type: "symlink", linkname: "../outside", size: 0 } },
			]),
			await packTar([
				{ header: { name: "package/a", type: "file", size: 1 }, body: "1" },
				{ header: { name: "package/a", type: "file", size: 1 }, body: "2" },
			]),
		]) {
			await expect(extract(gzipSync(tar), directory)).rejects.toThrow()
		}
	})
})
