import { MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES } from "@checkfu/sdk/Limits"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeArtifactMount, makeFilesMount } from "../src/Workspace/ArtifactMount.ts"
import type { SessionArtifacts } from "../src/Workspace/SessionArtifacts.ts"
import { makeAssistantReply, makePiDurableTestLayer } from "./helpers/ApiHarness.ts"
import {
	measureMountReads,
	mountReadCases,
	mountReadChunkBytes,
	mountReadFixture,
} from "./helpers/ArtifactMountMeasurements.ts"

const withMountFixtures = async <A, E>(
	sample: Effect.Effect<A, E, Effect.Services<ReturnType<typeof mountReadFixture>>>,
): Promise<A> => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	try {
		return await Effect.runPromise(sample.pipe(Effect.scoped, Effect.provide(layer)))
	} finally {
		await closeAll()
	}
}

describe("artifact mount", () => {
	it("scopes a known upload's stat and read to its own path", async () => {
		const root = "/mnt/session/uploads"
		const queries: Array<readonly [string, string | null]> = []
		const content = new TextEncoder().encode("available")
		const mount = makeFilesMount(
			root,
			{
				mounts: async () => [root],
				files: async (path, subtree) => {
					queries.push([path, subtree])
					if (subtree !== "nested/ready.txt") {
						throw new Error("An unrelated upload could not be checked.")
					}
					return [{ path: subtree, size: content.byteLength }]
				},
				read: async (_mount, _path, offset, length) => content.slice(offset, offset + length),
			},
			100,
		)
		await expect(mount.stat("nested/ready.txt")).resolves.toMatchObject({ size: content.length })
		const file = await mount.readFile("nested/ready.txt")
		expect(await new Response(file?.body).text()).toBe("available")
		expect(queries).toEqual([
			[root, "nested/ready.txt"],
			[root, "nested/ready.txt"],
		])
	})

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
		const mount = makeArtifactMount("/mnt/artifacts", artifacts, 100_000)

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
		const mount = makeArtifactMount("/mnt/artifacts", artifacts, 100_000)
		const file = await mount.readFile("big/data.txt", { range: { offset: 10 } })
		const reader = file?.body.getReader()
		const first = await reader?.read()
		await reader?.cancel()
		expect([first?.value?.byteLength, asked]).toEqual([256 * 1024, [[10, 256 * 1024]]])
	})

	it("bounds mounted reads and rechecks access while using the pinned manifest cache", async () => {
		const sample = await withMountFixtures(
			Effect.gen(function* () {
				const fixture = yield* mountReadFixture(MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_FILES)
				const read = (mode: Parameters<typeof fixture.read>[0]) =>
					Effect.promise(() => fixture.read(mode))
				return {
					full: yield* read("full"),
					random: yield* read("random"),
					edge: yield* read("edge"),
					eof: yield* read("eof"),
					cancel: yield* read("cancel"),
					revoke: yield* read("revoke"),
					cancelInFlight: yield* read("cancelInFlight"),
					revokeInFlight: yield* read("revokeInFlight"),
				}
			}),
		)
		const chunks = MAX_ARTIFACT_FILE_BYTES / mountReadChunkBytes
		expect(sample.full.requested).toEqual(
			Array.from({ length: chunks }, (_, index) => [
				index * mountReadChunkBytes,
				mountReadChunkBytes,
			]),
		)
		expect(sample.full).toMatchObject({
			mountLists: 1,
			fileLists: 1,
			pinReads: chunks + 2,
			artifactStateReads: chunks + 1,
			manifestLoads: 1,
			blobReads: chunks,
			requestedBytes: MAX_ARTIFACT_FILE_BYTES,
			returnedBytes: MAX_ARTIFACT_FILE_BYTES,
			consumedBytes: MAX_ARTIFACT_FILE_BYTES,
		})
		expect(sample.random.requested).toEqual([[MAX_ARTIFACT_FILE_BYTES / 2 + 17, 4096]])
		expect(sample.random).toMatchObject({
			pinReads: 3,
			artifactStateReads: 2,
			manifestLoads: 0,
			blobReads: 1,
			consumedBytes: 4096,
		})
		expect(sample.edge.requested).toEqual([
			[mountReadChunkBytes - 8, mountReadChunkBytes],
			[2 * mountReadChunkBytes - 8, 24],
		])
		expect(sample.edge.consumedBytes).toBe(mountReadChunkBytes + 24)
		expect(sample.eof).toMatchObject({
			requested: [],
			consumedBytes: 0,
			firstByteMs: null,
			blobReads: 0,
		})
		expect(sample.cancel).toMatchObject({
			requested: [[0, mountReadChunkBytes]],
			consumedBytes: mountReadChunkBytes,
			pinReads: 3,
			blobReads: 1,
		})
		expect(sample.revoke).toMatchObject({
			requested: [
				[0, mountReadChunkBytes],
				[mountReadChunkBytes, mountReadChunkBytes],
			],
			consumedBytes: mountReadChunkBytes,
			pinReads: 4,
			artifactStateReads: 2,
			blobReads: 1,
			revoked: true,
		})
		expect(sample.cancelInFlight).toMatchObject({
			requested: [
				[0, mountReadChunkBytes],
				[mountReadChunkBytes, mountReadChunkBytes],
			],
			consumedBytes: mountReadChunkBytes,
			blobReads: 2,
			returnedBytes: 2 * mountReadChunkBytes,
		})
		expect(sample.revokeInFlight).toMatchObject({
			requested: [
				[0, mountReadChunkBytes],
				[mountReadChunkBytes, mountReadChunkBytes],
				[2 * mountReadChunkBytes, mountReadChunkBytes],
			],
			consumedBytes: 2 * mountReadChunkBytes,
			blobReads: 2,
			returnedBytes: 2 * mountReadChunkBytes,
			revoked: true,
		})
		for (const read of Object.values(sample)) {
			expect(read.peakBufferedBytes).toBeLessThanOrEqual(mountReadChunkBytes)
		}
	}, 15_000)

	it.runIf(process.env["CHECKFU_MEASURE_ARTIFACT_MOUNT"] === "1")(
		"measures mounted reads",
		async () => {
			await withMountFixtures(
				Effect.gen(function* () {
					for (const measurement of mountReadCases) {
						const samples = yield* measureMountReads(measurement)
						for (const sample of samples) {
							process.stdout.write(`${JSON.stringify(sample)}\n`)
						}
					}
				}),
			)
		},
		30_000,
	)

	it("shares the recursive limit across all mounted manifests", async () => {
		const seen: Array<string> = []
		const mount = makeArtifactMount(
			"/mnt/artifacts",
			{
				mounts: async () => ["a", "b", "c"].map((name) => `/mnt/artifacts/${name}`),
				files: async (name) => {
					seen.push(name)
					return [
						{ path: "dir/x", size: 1 },
						{ path: "dir/y", size: 1 },
					]
				},
				read: async () => null,
			},
			20,
		)
		await expect(mount.readdir("", { recursive: true, limit: 8 })).rejects.toThrow(
			"More than 8 entries",
		)
		expect(seen).toEqual(["/mnt/artifacts/a", "/mnt/artifacts/b"])
		expect(await mount.readdir("", { recursive: true, limit: 12 })).toHaveLength(12)
	})

	it("lists a directory's children without walking its subtrees, and refuses a walk past the limit", async () => {
		const deep = Array.from({ length: 1000 }, (_, file) => ({
			path: `${Array.from({ length: 120 }, (_unused, level) => `d${level}`).join("/")}/f${file}.txt`,
			size: 1,
		}))
		const listed = (files: ReadonlyArray<{ readonly path: string; readonly size: number }>) =>
			makeArtifactMount(
				"/mnt/artifacts",
				{
					mounts: () => Promise.resolve(["/mnt/artifacts/data"]),
					files: () => Promise.resolve(files),
					read: () => Promise.resolve(new Uint8Array()),
				},
				2000,
			)
		const mount = listed([...deep, { path: "top.txt", size: 3 }])
		expect((await mount.readdir("data", {}))?.map(({ name }) => name)).toEqual(["d0", "top.txt"])
		expect(
			(await mount.readdir("data/d0/d1", { recursive: true }))?.filter(({ name }) =>
				name.endsWith(".txt"),
			).length,
		).toBe(1000)
		const wide = Array.from({ length: 2001 }, (_, file) => ({ path: `f${file}`, size: 1 }))
		await expect(listed(wide).readdir("data", { recursive: true })).rejects.toThrow(
			"entries to list",
		)
	})
})
