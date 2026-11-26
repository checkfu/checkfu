import { MAX_ARTIFACT_NAME_LENGTH } from "@checkfu/domain/Artifact/ArtifactTypes"
import { describe, expect, it } from "@effect/vitest"
import { outputsArtifactName } from "../src/OutputsIdentity.ts"
import {
	MAX_OUTPUT_FILE_BYTES,
	MAX_OUTPUT_TOTAL_BYTES,
	makeSessionOutputs,
} from "../src/Workspace/SessionOutputs.ts"

const workspace = () => {
	const reads: Array<string> = []
	const outputs = makeSessionOutputs({
		list: () => Promise.resolve([]),
		read: (file) => {
			reads.push(file)
			return Promise.resolve(new Uint8Array(0))
		},
	})
	return { reads, outputs }
}

describe("A session's outputs reader", () => {
	it("reads a path inside the outputs directory", async () => {
		const { reads, outputs } = workspace()
		await outputs.read([
			{ path: "report.md", size: 0 },
			{ path: "data/totals.csv", size: 0 },
		])
		expect(reads).toEqual(["report.md", "data/totals.csv"])
	})

	it.each(["../../../workspace/notes.md", "data/../../secret", "/etc/passwd", "./a.txt", ""])(
		"refuses %j without reading anything",
		async (path) => {
			const { reads, outputs } = workspace()
			await expect(
				outputs.read([
					{ path: "report.md", size: 0 },
					{ path, size: 0 },
				]),
			).rejects.toThrow("is not a path in the outputs directory")
			expect(reads).toEqual([])
		},
	)

	it("refuses unsupported directory entries before reading any regular files", async () => {
		const reads: Array<string> = []
		const outputs = makeSessionOutputs({
			list: async () => [
				{ path: "report.md", type: "file" },
				{ path: "unsupported", type: "other" },
			],
			read: async (path) => {
				reads.push(path)
				return new Uint8Array(0)
			},
		})
		expect(await outputs.list()).toEqual({
			ok: false,
			reason: 'Output "unsupported" must be a regular file or directory.',
		})
		expect(reads).toEqual([])
	})

	it("allows the exact file and aggregate limits and requests only one detection byte", async () => {
		const limits: Array<number> = []
		const paths = ["a", "b", "c", "d", "empty"]
		const outputs = makeSessionOutputs({
			list: async () => paths.map((path) => ({ path, type: "file" })),
			read: async (path, limit) => {
				limits.push(limit)
				return new Uint8Array(path === "empty" ? 0 : MAX_OUTPUT_FILE_BYTES)
			},
		})
		const result = await outputs.list()
		expect(result.ok && result.files.reduce((sum, { size }) => sum + size, 0)).toBe(
			MAX_OUTPUT_TOTAL_BYTES,
		)
		expect(limits).toEqual([...Array(4).fill(MAX_OUTPUT_FILE_BYTES + 1), 1])
	})

	it.each([2, 4])("discards a %i-byte reread of a 3-byte file", async (size) => {
		const limits: Array<number> = []
		const outputs = makeSessionOutputs({
			list: async () => [],
			read: async (_, limit) => {
				limits.push(limit)
				return new Uint8Array(size)
			},
		})
		expect(await outputs.read([{ path: "report.md", size: 3 }])).toEqual([])
		expect(limits).toEqual([4])
	})
})

describe("A session's outputs artifact name", () => {
	it("keeps the fallback within the artifact name limit for the longest session id", () => {
		const name = outputsArtifactName("s".repeat(256), null)
		expect(Array.from(name)).toHaveLength(MAX_ARTIFACT_NAME_LENGTH)
		expect(name.startsWith("Session s")).toBe(true)
	})
})
