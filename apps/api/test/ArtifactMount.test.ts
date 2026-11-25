import { describe, expect, it } from "@effect/vitest"
import { makeArtifactMount } from "../src/Workspace/ArtifactMount.ts"
import type { SessionArtifacts } from "../src/Workspace/SessionArtifacts.ts"

describe("artifact mount", () => {
	it("asks the store only for the range a read pages through", async () => {
		const content = new TextEncoder().encode("x".repeat(1000))
		const asked: Array<readonly [number, number]> = []
		const artifacts: SessionArtifacts = {
			mounts: () => Promise.resolve(["/mnt/artifacts/big"]),
			files: () => Promise.resolve([{ path: "data.txt", size: content.byteLength }]),
			read: (_mount, _path, offset, length) => {
				asked.push([offset, length])
				return Promise.resolve(content.slice(offset, offset + length))
			},
		}
		const mount = makeArtifactMount("/mnt/artifacts", artifacts)

		const page = await mount.readFile("big/data.txt", { range: { offset: 900, length: 300 } })
		expect(page?.offset).toBe(900)
		expect(page?.stat.size).toBe(1000)
		expect((await new Response(page?.body).bytes()).byteLength).toBe(100)
		const whole = await mount.readFile("big/data.txt")
		expect((await new Response(whole?.body).bytes()).byteLength).toBe(1000)
		expect(asked).toEqual([
			[900, 100],
			[0, 1000],
		])
	})

	it("reads a file in ranges as it is consumed, so a reader that stops early moves little", async () => {
		const content = new Uint8Array(1024 * 1024).fill(120)
		const asked: Array<readonly [number, number]> = []
		const artifacts: SessionArtifacts = {
			mounts: () => Promise.resolve(["/mnt/artifacts/big"]),
			files: () => Promise.resolve([{ path: "data.txt", size: content.byteLength }]),
			read: (_mount, _path, offset, length) => {
				asked.push([offset, length])
				return Promise.resolve(content.slice(offset, offset + length))
			},
		}
		const mount = makeArtifactMount("/mnt/artifacts", artifacts)
		const file = await mount.readFile("big/data.txt", { range: { offset: 10 } })
		const reader = file?.body.getReader()
		const first = await reader?.read()
		await reader?.cancel()
		expect([first?.value?.byteLength, asked]).toEqual([256 * 1024, [[10, 256 * 1024]]])
	})
})
