import { describe, expect, it } from "@effect/vitest"
import { scriptOutputEnv } from "../src/Pi/PiCodemode.ts"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"

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
