import { describe, expect, it } from "@effect/vitest"
import {
	MAX_OUTPUT_FILE_BYTES,
	MAX_OUTPUT_FILES,
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

	it("saves the regular files and skips, by name, what is not one or is not allowed", async () => {
		const reads: Array<string> = []
		const outputs = makeSessionOutputs({
			list: async () => [
				{ path: "report.md", type: "file" },
				{ path: "data", type: "dir" },
				{ path: "link", type: "symlink" },
				{ path: "bad\u0001name", type: "file" },
			],
			read: async (path) => {
				reads.push(path)
				return new Uint8Array(2)
			},
		})
		expect(await outputs.list()).toEqual({
			ok: true,
			files: [{ path: "report.md", size: 2, sha256: expect.any(String) }],
			skipped: [
				{ path: "link", reason: "Not a regular file." },
				{ path: "bad?name", reason: "This path is not allowed." },
			],
		})
		expect(reads).toEqual(["report.md"])
	})

	it("skips only the file over the limit, the one that changed, and those past the total", async () => {
		const sizes = new Map(
			Object.entries({
				a: MAX_OUTPUT_FILE_BYTES,
				b: MAX_OUTPUT_FILE_BYTES + 1,
				c: MAX_OUTPUT_FILE_BYTES,
				d: MAX_OUTPUT_FILE_BYTES,
				e: MAX_OUTPUT_FILE_BYTES,
				f: 1,
				g: 0,
			}),
		)
		const outputs = makeSessionOutputs({
			list: async () => [...sizes.keys(), "gone"].map((path) => ({ path, type: "file" })),
			read: async (path, limit) =>
				path === "gone"
					? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
					: new Uint8Array(Math.min(sizes.get(path) ?? 0, limit)),
		})
		const result = await outputs.list()
		expect(result.ok && result.files.map(({ path }) => path)).toEqual(["a", "c", "d", "e", "g"])
		expect(result.ok && result.skipped).toEqual([
			{ path: "b", reason: `Larger than ${MAX_OUTPUT_FILE_BYTES} bytes.` },
			{ path: "f", reason: `The outputs total more than ${MAX_OUTPUT_TOTAL_BYTES} bytes.` },
			{ path: "gone", reason: "Changed while it was being read." },
		])
	})

	it("refuses the whole directory only when it holds more files than a record can name", async () => {
		const outputs = makeSessionOutputs({
			list: async () =>
				Array.from({ length: MAX_OUTPUT_FILES + 1 }, (_, index) => ({
					path: `f${index}`,
					type: "file",
				})),
			read: async () => new Uint8Array(0),
		})
		expect(await outputs.list()).toEqual({
			ok: false,
			reason: `${MAX_OUTPUT_FILES + 1} files; the limit is ${MAX_OUTPUT_FILES}.`,
		})
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

	it("shows a path it cannot allow in a short printable form", async () => {
		const outputs = makeSessionOutputs({
			list: async () => [{ path: `\u0000\u0085${"x".repeat(600)}`, type: "file" }],
			read: async () => new Uint8Array(0),
		})
		const result = await outputs.list()
		expect(result.ok && result.skipped).toEqual([
			{ path: `??${"x".repeat(126)}`, reason: "This path is not allowed." },
		])
	})

	it("reports a pruned output directory while saving its sibling", async () => {
		const reads: Array<string> = []
		const directory = ["a".repeat(200), "b".repeat(200), "c".repeat(120)].join("/")
		const outputs = makeSessionOutputs({
			list: async () => [
				{ path: directory, type: "pruned_directory" },
				{ path: "report.txt", type: "file" },
			],
			read: async (path) => {
				reads.push(path)
				return new Uint8Array(1)
			},
		})
		expect(await outputs.list()).toMatchObject({
			ok: true,
			files: [{ path: "report.txt" }],
			skipped: [
				{ path: "a".repeat(128), reason: "Directory path too long. Its contents were skipped." },
			],
		})
		expect(reads).toEqual(["report.txt"])
	})

	it("reads the files after one that is gone or has changed size", async () => {
		const outputs = makeSessionOutputs({
			list: async () => [],
			read: async (path) =>
				path === "gone"
					? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
					: new Uint8Array(path === "grew" ? 5 : 3),
		})
		expect(
			(
				await outputs.read([
					{ path: "gone", size: 3 },
					{ path: "grew", size: 3 },
					{ path: "kept", size: 3 },
				])
			).map(({ path }) => path),
		).toEqual(["kept"])
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
