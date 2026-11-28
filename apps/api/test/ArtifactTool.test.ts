import { describe, expect, it } from "@effect/vitest"
import { MAX_ARTIFACT_DECLARATION_BYTES } from "@checkfu/sdk/Schemas"
import {
	MAX_TOOL_ARTIFACT_FILES,
	MAX_TOOL_ARTIFACT_FILE_BYTES,
	MAX_TOOL_ARTIFACT_TOTAL_BYTES,
} from "../src/Workspace/SessionArtifactTool.ts"
import { saveArtifact } from "../src/Workspace/ArtifactTool.ts"
import type { ArtifactToolPorts } from "../src/Workspace/ArtifactTool.ts"

const workspace = (
	files: ReadonlyMap<string, number | "symlink">,
	over: Partial<ArtifactToolPorts> = {},
) => {
	const saved: Array<string> = []
	const artifacts: Array<{ name: string; paths: ReadonlyArray<string> }> = []
	const reads: Array<[string, number]> = []
	const ports: ArtifactToolPorts = {
		capture: (directory) => ({
			list: async () => {
				const inside = [...files.keys()].filter(
					(path) => path.startsWith(`${directory}/`) && path !== `${directory}/`,
				)
				if (inside.length === 0 && !files.has(`${directory}/`)) {
					throw Object.assign(new Error("Directory is missing."), { code: "ENOENT" })
				}
				const folders = new Set(
					inside.flatMap((path) => {
						const parts = path.slice(directory.length + 1).split("/")
						return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join("/"))
					}),
				)
				return [
					...[...folders].map((path) => ({ path, type: "dir", size: 0 })),
					...inside.map((path) => ({
						path: path.slice(directory.length + 1),
						type: files.get(path) === "symlink" ? "symlink" : "file",
						size: Number(files.get(path)) || 0,
					})),
				]
			},
			read: async (relative, limit) => {
				const path = `${directory}/${relative}`
				reads.push([path, limit])
				const size = files.get(path)
				return new Uint8Array(typeof size === "number" ? Math.min(size, limit) : 0)
			},
		}),
		saveFile: async ({ directory, path }) => {
			expect(directory).toMatch(/^\/(workspace|mnt\/session\/outputs)/)
			saved.push(path)
			return { ok: true, file_id: `file_${path}` }
		},
		saveArtifact: async (name, entries) => {
			artifacts.push({ name, paths: entries.map((entry) => entry.path) })
			return {
				ok: true,
				artifact_id: "art_1",
				version: artifacts.length,
				file_count: entries.length,
				changed: true,
			}
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
		const result = await saveArtifact({ name: "Site", directory: "/workspace//site/./" }, ports)
		expect(result.isError).toBe(false)
		expect(textOf(result)).toBe('Saved "Site" as artifact art_1, version 1, with 3 files.')
		expect(saved).toEqual(["assets/app.js", "assets/img/logo.png", "index.html"])
		expect(artifacts).toEqual([{ name: "Site", paths: saved }])
	})

	it("saves an attached source with no additional files", async () => {
		const { ports, saved } = workspace(new Map([["/workspace/site/", 0]]))
		const saveFrom = async (_name: string, entries: ReadonlyArray<unknown>, source: string) => {
			expect(entries).toEqual([])
			expect(source).toBe("/mnt/artifacts/template")
			return { ok: true as const, artifact_id: "art_1", version: 1, file_count: 2, changed: true }
		}
		const result = await saveArtifact(
			{ name: "Dashboard", directory: "/workspace/site", made_from: "/mnt/artifacts/template" },
			{ ...ports, saveArtifact: saveFrom },
		)
		expect(result.isError).toBe(false)
		expect(textOf(result)).toBe('Saved "Dashboard" as artifact art_1, version 1, with 2 files.')
		expect(saved).toEqual([])
	})

	it("says when nothing changed", async () => {
		const { ports } = workspace(new Map([["/workspace/site/index.html", 10]]), {
			saveArtifact: async () => ({
				ok: true,
				artifact_id: "art_1",
				version: 4,
				file_count: 1,
				changed: false,
			}),
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
		expect(await refusal(one, { name: "Site", directory: "/workspace/../mnt/files" })).toContain(
			"Choose a directory",
		)
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

	it("checks file and total size before reading or saving anything", async () => {
		const large = workspace(
			new Map([
				["/workspace/a.bin", 1],
				["/workspace/b.bin", MAX_TOOL_ARTIFACT_FILE_BYTES + 5],
				["/workspace/c.bin", 1],
			]),
		)
		const tooLarge = await saveArtifact({ name: "Data", directory: "/workspace" }, large.ports)
		expect(textOf(tooLarge)).toBe("b.bin is larger than 8 MiB.")
		expect(large.saved).toEqual([])
		expect(large.reads).toEqual([])
		expect(large.artifacts).toEqual([])

		const count = MAX_TOOL_ARTIFACT_TOTAL_BYTES / MAX_TOOL_ARTIFACT_FILE_BYTES
		const full = workspace(
			new Map([
				...Array.from({ length: count }, (_, index): [string, number] => [
					`/workspace/${index}.bin`,
					MAX_TOOL_ARTIFACT_FILE_BYTES,
				]),
				["/workspace/z.txt", 1],
			]),
		)
		expect(textOf(await saveArtifact({ name: "Data", directory: "/workspace" }, full.ports))).toBe(
			"The files total more than 64 MiB.",
		)
		expect(full.saved).toEqual([])
		expect(full.reads).toEqual([])
		expect(full.artifacts).toEqual([])
	})

	it.each([
		{ path: "_/platform.js", size: 1, message: "is under _/, which is reserved" },
		{ path: "_", size: 1, message: "is under _/, which is reserved" },
		{
			path: "artifact.json",
			size: MAX_ARTIFACT_DECLARATION_BYTES + 1,
			message: `it is larger than ${MAX_ARTIFACT_DECLARATION_BYTES} bytes`,
		},
		{
			path: "artifact.json",
			size: 1,
			madeFrom: "/mnt/artifacts/base",
			message: "is supplied by the source version",
		},
	])("rejects an ineligible $path before reading or saving siblings", async (fixture) => {
		const tool = workspace(
			new Map([
				["/workspace/0.txt", 1],
				[`/workspace/${fixture.path}`, fixture.size],
			]),
		)
		const result = await saveArtifact(
			{
				name: "Site",
				directory: "/workspace",
				...("madeFrom" in fixture ? { made_from: fixture.madeFrom } : {}),
			},
			tool.ports,
		)
		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain(fixture.message)
		expect([tool.reads, tool.saved, tool.artifacts]).toEqual([[], [], []])
	})

	it("accepts an empty reserved directory, neighboring names, and a declaration at the limit", async () => {
		const { ports, saved } = workspace(
			new Map([
				["/workspace/_suffix", 1],
				["/workspace/artifact.json", MAX_ARTIFACT_DECLARATION_BYTES],
				["/workspace/assets/_/data", 2],
				["/workspace/assets/artifact.json", MAX_ARTIFACT_DECLARATION_BYTES + 1],
			]),
		)
		const capture: ArtifactToolPorts["capture"] = (directory) => {
			const files = ports.capture(directory)
			return {
				...files,
				list: async (limit) => [{ path: "_", size: 0, type: "dir" }, ...(await files.list(limit))],
			}
		}
		const result = await saveArtifact(
			{ name: "Site", directory: "/workspace" },
			{ ...ports, capture },
		)
		expect(result.isError).toBe(false)
		expect(saved).toEqual(["_suffix", "artifact.json", "assets/_/data", "assets/artifact.json"])
	})

	it("declines a declaration that grew since listing before uploading siblings", async () => {
		const { ports, saved, artifacts } = workspace(
			new Map([
				["/workspace/0.txt", 1],
				["/workspace/artifact.json", 1],
			]),
		)
		const capture: ArtifactToolPorts["capture"] = (directory) => ({
			...ports.capture(directory),
			read: async (path, limit) => {
				expect(path).toBe("artifact.json")
				expect(limit).toBe(MAX_ARTIFACT_DECLARATION_BYTES + 1)
				return new Uint8Array(limit)
			},
		})
		const result = await saveArtifact(
			{ name: "Site", directory: "/workspace" },
			{ ...ports, capture },
		)
		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain(`it is larger than ${MAX_ARTIFACT_DECLARATION_BYTES} bytes`)
		expect([saved, artifacts]).toEqual([[], []])
	})

	it("stops before starting any more writes when the turn is canceled", async () => {
		const stopping = new AbortController()
		const { ports, reads, artifacts } = workspace(
			new Map([
				["/workspace/a.txt", 1],
				["/workspace/b.txt", 2],
			]),
			{
				saveFile: async () => {
					stopping.abort()
					return { ok: true, file_id: "file_a" }
				},
			},
		)
		await expect(
			saveArtifact({ name: "Files", directory: "/workspace" }, ports, stopping.signal),
		).rejects.toMatchObject({ name: "AbortError" })
		expect(reads.map(([path]) => path)).toEqual(["/workspace/a.txt"])
		expect(artifacts).toEqual([])
	})

	it("passes on why a file or the artifact was not saved", async () => {
		const files = new Map<string, number | "symlink">([["/workspace/a.txt", 1]])
		const noFile = workspace(files, {
			saveFile: async () => ({ ok: false, message: "The session has ended." }),
		})
		const first = await saveArtifact({ name: "A", directory: "/workspace" }, noFile.ports)
		expect([first.isError, textOf(first), noFile.artifacts]).toEqual([
			true,
			"The session has ended.",
			[],
		])
		const noArtifact = workspace(files, {
			saveArtifact: async () => ({ ok: false, message: 'The artifact named "A" was deleted.' }),
		})
		const second = await saveArtifact({ name: "A", directory: "/workspace" }, noArtifact.ports)
		expect([second.isError, textOf(second)]).toEqual([true, 'The artifact named "A" was deleted.'])
	})
})
