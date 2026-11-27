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
		size: async (path) => {
			const size = files.get(path)
			if (typeof size !== "number") {
				throw new Error("ENOENT")
			}
			return size
		},
		stopped: () => false,
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

const INTERRUPTED =
	"The turn was interrupted while the artifact was being saved. Call save_artifact again to see whether it was."

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
		expect(await refusal(one, { name: "Site", directory: "/workspace/x/../site" })).toContain(
			"no .. in it",
		)
		expect(await refusal(new Map())).toBe("/workspace/site is not a directory that can be read.")
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

	it("takes a directory however its path is spelled, and refuses a listing that strays outside it", async () => {
		for (const directory of ["/workspace/./site", "/workspace//site", "/workspace/site//"]) {
			const { ports, saved } = workspace(new Map([["/workspace/site/index.html", 1]]))
			const result = await saveArtifact({ name: "Site", directory }, ports)
			expect([directory, result.isError, saved]).toEqual([directory, false, ["index.html"]])
		}
		const stray = workspace(new Map([["/workspace/site/index.html", 1]]), {
			find: async () => [{ path: "/workspace/other/secret.txt", type: "file" }],
		})
		const result = await saveArtifact({ name: "Site", directory: "/workspace/site" }, stray.ports)
		expect([textOf(result), stray.saved]).toEqual([
			"/workspace/other/secret.txt is outside /workspace/site.",
			[],
		])
	})

	it("checks every size before saving anything, so a refusal leaves no files behind", async () => {
		const large = workspace(
			new Map([
				["/w/a.bin", 1],
				["/w/b.bin", MAX_TOOL_ARTIFACT_FILE_BYTES + 5],
				["/w/c.bin", 1],
			]),
		)
		const tooLarge = await saveArtifact({ name: "Data", directory: "/w" }, large.ports)
		expect(textOf(tooLarge)).toBe("b.bin is larger than 8 MiB.")
		expect([large.saved, large.reads, large.artifacts]).toEqual([[], [], []])

		const count = MAX_TOOL_ARTIFACT_TOTAL_BYTES / MAX_TOOL_ARTIFACT_FILE_BYTES
		const exact = Array.from({ length: count }, (_, index): [string, number] => [
			`/w/${index}.bin`,
			MAX_TOOL_ARTIFACT_FILE_BYTES,
		])
		const full = workspace(new Map([...exact, ["/w/z.txt", 1]]))
		expect(textOf(await saveArtifact({ name: "Data", directory: "/w" }, full.ports))).toBe(
			"The files total more than 64 MiB.",
		)
		expect([full.saved, full.artifacts]).toEqual([[], []])

		const fits = workspace(new Map(exact))
		expect((await saveArtifact({ name: "Data", directory: "/w" }, fits.ports)).isError).toBe(false)
		expect(fits.saved).toHaveLength(count)
	})

	it("refuses a file that grew past the limit after its size was checked", async () => {
		const grown = workspace(new Map([["/w/a.bin", 1]]), {
			read: async (_, limit) => new Uint8Array(limit + 1),
		})
		expect(textOf(await saveArtifact({ name: "Data", directory: "/w" }, grown.ports))).toBe(
			"a.bin is larger than 8 MiB.",
		)
		expect(grown.artifacts).toEqual([])
	})

	it("stops when the turn is interrupted, before the next file and before the artifact", async () => {
		let stopped = false
		const world = workspace(
			new Map([
				["/w/a.txt", 1],
				["/w/b.txt", 1],
			]),
			{ stopped: () => stopped },
		)
		const saveFile = world.ports.saveFile
		const ports = {
			...world.ports,
			saveFile: async (path: string, bytes: Uint8Array) => {
				const saved = await saveFile(path, bytes)
				stopped = true
				return saved
			},
		}
		const result = await saveArtifact({ name: "Data", directory: "/w" }, ports)
		expect([result.isError, textOf(result), world.saved, world.artifacts]).toEqual([
			true,
			INTERRUPTED,
			["a.txt"],
			[],
		])

		let cut = false
		const midCall = workspace(new Map([["/w/a.txt", 1]]), {
			stopped: () => cut,
			saveArtifact: () => {
				cut = true
				return Promise.reject(new Error("aborted"))
			},
		})
		expect(textOf(await saveArtifact({ name: "Data", directory: "/w" }, midCall.ports))).toBe(
			INTERRUPTED,
		)
	})

	it("answers plainly when a save cannot reach the API", async () => {
		const files = new Map<string, number | "symlink">([["/w/a.txt", 1]])
		const unreachable = () => Promise.reject(new Error("internal: socket hang up at 10.0.0.4"))
		const noFile = await saveArtifact(
			{ name: "A", directory: "/w" },
			workspace(files, { saveFile: unreachable }).ports,
		)
		expect([noFile.isError, textOf(noFile)]).toEqual([true, "Saving a.txt failed; try again."])
		const noArtifact = await saveArtifact(
			{ name: "A", directory: "/w" },
			workspace(files, { saveArtifact: unreachable }).ports,
		)
		expect([noArtifact.isError, textOf(noArtifact)]).toEqual([
			true,
			"Saving the artifact failed; try again.",
		])
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
