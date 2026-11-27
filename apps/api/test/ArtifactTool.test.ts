import { describe, expect, it } from "@effect/vitest"
import {
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
	saveArtifact,
} from "../src/Workspace/ArtifactTool.ts"
import type { ArtifactToolPorts } from "../src/Workspace/ArtifactTool.ts"

const workspace = (
	files: ReadonlyMap<string, number | "symlink">,
	over: Partial<ArtifactToolPorts> = {},
) => {
	const saved: Array<string> = []
	const artifacts: Array<{ name: string; paths: ReadonlyArray<string> }> = []
	const reads: Array<[string, number]> = []
	const ports: ArtifactToolPorts = {
		find: async (directory) => {
			const inside = [...files.keys()].filter(
				(path) => path.startsWith(`${directory}/`) && path !== `${directory}/`,
			)
			if (inside.length === 0 && !files.has(`${directory}/`)) {
				throw new Error("ENOENT")
			}
			const folders = new Set(
				inside.flatMap((path) => {
					const parts = path.slice(directory.length + 1).split("/")
					return parts
						.slice(0, -1)
						.map((_, at) => `${directory}/${parts.slice(0, at + 1).join("/")}`)
				}),
			)
			return [
				...[...folders].map((path) => ({ path, type: "dir" })),
				...inside.map((path) => ({
					path,
					type: files.get(path) === "symlink" ? "symlink" : "file",
				})),
			]
		},
		read: async (path, limit) => {
			reads.push([path, limit])
			const size = files.get(path)
			return new Uint8Array(typeof size === "number" ? Math.min(size, limit + 1) : 0)
		},
		saveFile: async (path) => {
			saved.push(path)
			return { ok: true, file_id: `file_${path}` }
		},
		saveArtifact: async (name, entries) => {
			artifacts.push({ name, paths: entries.map((entry) => entry.path) })
			return { ok: true, artifact_id: "art_1", version: artifacts.length, changed: true }
		},
		...over,
	}
	return { ports, saved, artifacts, reads }
}

const textOf = (result: Awaited<ReturnType<typeof saveArtifact>>) =>
	result.content.map((part) => (part.type === "text" ? part.text : "")).join("")

describe("the save_artifact tool", () => {
	it("saves every file under the directory by its path inside it, in order, then the artifact", async () => {
		const { ports, saved, artifacts } = workspace(
			new Map([
				["/workspace/site/index.html", 10],
				["/workspace/site/assets/app.js", 20],
				["/workspace/site/assets/img/logo.png", 30],
				["/workspace/other.txt", 5],
			]),
		)
		const result = await saveArtifact({ name: "Site", directory: "/workspace/site/" }, ports)
		expect(result.isError).toBe(false)
		expect(textOf(result)).toBe('Saved "Site" as artifact art_1, version 1, with 3 files.')
		expect(saved).toEqual(["assets/app.js", "assets/img/logo.png", "index.html"])
		expect(artifacts).toEqual([{ name: "Site", paths: saved }])
	})

	it("says when nothing changed", async () => {
		const { ports } = workspace(new Map([["/workspace/site/index.html", 10]]), {
			saveArtifact: async () => ({ ok: true, artifact_id: "art_1", version: 4, changed: false }),
		})
		expect(textOf(await saveArtifact({ name: "Site", directory: "/workspace/site" }, ports))).toBe(
			'"Site" is unchanged: artifact art_1 is still at version 4, with 1 file.',
		)
	})

	it("refuses bad arguments, a missing or empty directory, and what an artifact cannot hold, saving nothing", async () => {
		const refusal = async (
			files: ReadonlyMap<string, number | "symlink">,
			args: unknown = { name: "Site", directory: "/workspace/site" },
		) => {
			const { ports, saved, artifacts } = workspace(files)
			const result = await saveArtifact(args, ports)
			expect([result.isError, saved, artifacts]).toEqual([true, [], []])
			return textOf(result)
		}
		const one = new Map<string, number | "symlink">([["/workspace/site/index.html", 1]])
		expect(await refusal(one, { name: "Site" })).toContain("needs a name and a directory")
		expect(await refusal(one, { name: "Site", directory: "site" })).toContain("absolute path")
		expect(await refusal(new Map())).toBe("/workspace/site is not a directory.")
		expect(await refusal(new Map([["/workspace/site/", 0]]))).toBe(
			"/workspace/site holds no files.",
		)
		expect(await refusal(new Map([...one, ["/workspace/site/link", "symlink"]]))).toContain(
			"link is not a regular file",
		)
		expect(await refusal(new Map([...one, ["/workspace/site/bad\u0001name", 1]]))).toContain(
			"is not a path an artifact can hold",
		)
		expect(
			await refusal(
				new Map(
					Array.from({ length: MAX_TOOL_ARTIFACT_FILES + 1 }, (_, index) => [
						`/workspace/site/${index}.txt`,
						1,
					]),
				),
			),
		).toBe(
			`${MAX_TOOL_ARTIFACT_FILES + 1} files; an artifact saved here holds at most ${MAX_TOOL_ARTIFACT_FILES}.`,
		)
	})

	it("stops at the first file over the size limit or past the total, reading no more than it needs", async () => {
		const large = workspace(
			new Map([
				["/w/a.bin", 1],
				["/w/b.bin", MAX_TOOL_ARTIFACT_FILE_BYTES + 5],
				["/w/c.bin", 1],
			]),
		)
		const tooLarge = await saveArtifact({ name: "Data", directory: "/w" }, large.ports)
		expect(textOf(tooLarge)).toBe("b.bin is larger than 8 MiB.")
		expect(large.saved).toEqual(["a.bin"])
		expect(large.reads).toEqual([
			["/w/a.bin", MAX_TOOL_ARTIFACT_FILE_BYTES],
			["/w/b.bin", MAX_TOOL_ARTIFACT_FILE_BYTES],
		])
		expect(large.artifacts).toEqual([])

		const count = MAX_TOOL_ARTIFACT_TOTAL_BYTES / MAX_TOOL_ARTIFACT_FILE_BYTES
		const full = workspace(
			new Map([
				...Array.from({ length: count }, (_, index): [string, number] => [
					`/w/${index}.bin`,
					MAX_TOOL_ARTIFACT_FILE_BYTES,
				]),
				["/w/z.txt", 1],
			]),
		)
		expect(textOf(await saveArtifact({ name: "Data", directory: "/w" }, full.ports))).toBe(
			"The files total more than 64 MiB.",
		)
		expect(full.saved).toHaveLength(count)
		expect(full.artifacts).toEqual([])
	})

	it("passes on why a file or the artifact was not saved", async () => {
		const files = new Map<string, number | "symlink">([["/w/a.txt", 1]])
		const noFile = workspace(files, {
			saveFile: async () => ({ ok: false, message: "The session has ended." }),
		})
		const first = await saveArtifact({ name: "A", directory: "/w" }, noFile.ports)
		expect([first.isError, textOf(first), noFile.artifacts]).toEqual([
			true,
			"The session has ended.",
			[],
		])
		const noArtifact = workspace(files, {
			saveArtifact: async () => ({ ok: false, message: 'The artifact named "A" was deleted.' }),
		})
		const second = await saveArtifact({ name: "A", directory: "/w" }, noArtifact.ports)
		expect([second.isError, textOf(second)]).toEqual([true, 'The artifact named "A" was deleted.'])
	})
})
