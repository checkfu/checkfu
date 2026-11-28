import { describe, expect, it } from "@effect/vitest"
import { scriptOutputEnv } from "../src/Pi/PiCodemode.ts"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"

import { callSignal, withCallSignal } from "../src/Workspace/CallSignal.ts"
import { writeFileIn } from "../src/Workspace/SessionWorkspace.do.ts"

describe("Where scripts save their output", () => {
	it("writes text and bytes into its own directory of the workspace and refuses everything else", async () => {
		const written: Array<readonly [string, string | Uint8Array]> = []
		const env = scriptOutputEnv((path, content) => {
			written.push([path, content])
			return Promise.resolve(undefined)
		})
		const dir = await env.createTempDir("pi-codemode-", BACKGROUND_CONTEXT)
		expect(dir.ok && dir.value.startsWith("/workspace/.scripts/pi-codemode-")).toBe(true)
		const path = `${dir.ok ? dir.value : ""}/output.txt`

		expect(await env.writeFile(path, "full text", BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: undefined,
		})
		expect(
			(await env.writeFile(`${path}.png`, new Uint8Array([1, 2]), BACKGROUND_CONTEXT)).ok,
		).toBe(true)
		expect(written).toEqual([
			[path, "full text"],
			[`${path}.png`, new Uint8Array([1, 2])],
		])
		expect((await env.readTextFile(path, BACKGROUND_CONTEXT)).ok).toBe(false)
		expect((await env.exec("ls", undefined, BACKGROUND_CONTEXT)).ok).toBe(false)
	})

	it("refuses a cancelled invocation before dispatch and keeps a sibling live", async () => {
		const cancelled = new AbortController()
		cancelled.abort()
		const seen: Array<AbortSignal | undefined> = []
		const scoped = scriptOutputEnv((_path, _content, signal) => {
			seen.push(signal)
			return Promise.resolve(undefined)
		})
		const path = "/workspace/.scripts/run/output.txt"
		const stopped = await scoped.writeFile(
			path,
			"discard",
			withAbortSignal(cancelled.signal, BACKGROUND_CONTEXT),
		)
		expect(stopped.ok ? "" : stopped.error.message).toBe("The script invocation has ended.")
		expect(seen).toEqual([])
		const sibling = new AbortController()
		expect(
			(
				await scoped.writeFile(
					path,
					new Uint8Array([128]),
					withAbortSignal(sibling.signal, BACKGROUND_CONTEXT),
				)
			).ok,
		).toBe(true)
		expect(seen).toHaveLength(1)
		expect(seen[0]?.aborted).toBe(false)
	})

	it("does not dispatch the provider write when cancellation arrives during mkdir", async () => {
		const blocked = Promise.withResolvers<void>()
		const entered = Promise.withResolvers<void>()
		const writes: Array<string> = []
		const signal = new AbortController()
		const path = "/workspace/.scripts/run/output"
		const fs = {
			mkdir: async () => {
				entered.resolve()
				await blocked.promise
			},
			writeFile: async (path: string) => {
				writes.push(path)
			},
		}
		const writing = withCallSignal(signal.signal, () => writeFileIn(fs, path, "stop"))
		await entered.promise
		signal.abort()
		blocked.resolve()
		await expect(writing).rejects.toMatchObject({ name: "AbortError" })
		expect(writes).toEqual([])
		await writeFileIn(fs, path, "keep")
		expect(writes).toEqual([path])
	})

	it("passes cancellation to an already dispatched mounted write", async () => {
		const entered = Promise.withResolvers<void>()
		const invocation = new AbortController()
		const path = "/workspace/.scripts/run/output"
		const fs = {
			mkdir: () => Promise.resolve(),
			writeFile: async () => {
				const signal = callSignal()
				expect(signal).toBe(invocation.signal)
				const stopped = Promise.withResolvers<void>()
				signal?.addEventListener("abort", () => stopped.resolve(), { once: true })
				entered.resolve()
				await stopped.promise
				signal?.throwIfAborted()
			},
		}
		const writing = withCallSignal(invocation.signal, () => writeFileIn(fs, path, "stop"))
		await entered.promise
		invocation.abort()
		await expect(writing).rejects.toMatchObject({ name: "AbortError" })
	})

	it("names each run's directory with a whole UUID", async () => {
		const env = scriptOutputEnv(() => Promise.resolve(undefined))
		const dir = await env.createTempDir("pi-codemode-", BACKGROUND_CONTEXT)
		expect(dir.ok ? dir.value : "").toMatch(
			/^\/workspace\/\.scripts\/pi-codemode-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
		)
	})

	it("passes the workspace's refusal on", async () => {
		const env = scriptOutputEnv(() => Promise.resolve("disk full"))
		const result = await env.writeFile(
			"/workspace/.scripts/x/output.txt",
			"text",
			BACKGROUND_CONTEXT,
		)
		expect(result.ok).toBe(false)
		expect(result.ok ? "" : result.error.message).toBe("disk full")
	})

	it("turns a write that throws into a refusal", async () => {
		const env = scriptOutputEnv(() =>
			Promise.reject(new Error("/workspace/.scripts is not a directory")),
		)
		const result = await env.writeFile("/workspace/.scripts/y/image-1.png", "x", BACKGROUND_CONTEXT)
		expect(result.ok ? "" : result.error.message).toBe("/workspace/.scripts is not a directory")
	})
})
