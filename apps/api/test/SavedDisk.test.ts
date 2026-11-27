import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { inPieces, makeSavedDisk } from "../src/Workspace/SavedDisk.ts"
import type { DiskSql } from "../src/Workspace/SavedDisk.ts"
import { purgeTables } from "../src/Workspace/WorkspaceStorage.ts"

const makeDisk = () => {
	const db = new DatabaseSync(":memory:")
	const sql: DiskSql = {
		exec: (query, ...bindings) => db.prepare(query).all(...bindings),
		atomically: (work) => {
			db.exec("BEGIN")
			try {
				work()
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
	}
	const rows = () =>
		db
			.prepare("SELECT generation, part, length(bytes) AS size FROM machine_disk ORDER BY 1, 2")
			.all()
	return { db, sql, rows, disk: makeSavedDisk(sql) }
}

async function* of(...chunks: ReadonlyArray<Uint8Array>): AsyncGenerator<Uint8Array> {
	yield* chunks
}
const collect = async (
	chunks: AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array | undefined> => {
	if (chunks === undefined) {
		return undefined
	}
	const parts: Array<Uint8Array> = []
	for await (const chunk of chunks) {
		parts.push(chunk)
	}
	return Uint8Array.from(parts.flatMap((part) => [...part]))
}
const patterned = (length: number, seed: number): Uint8Array =>
	Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256)

const whole = (...chunks: ReadonlyArray<Uint8Array>) => ({
	chunks: of(...chunks),
	compressed: true,
})
const read = async (disk: ReturnType<typeof makeDisk>["disk"]) => {
	const archive = disk.read()
	return archive === undefined
		? undefined
		: { bytes: await collect(archive.chunks), compressed: archive.compressed }
}

describe("saved disk", () => {
	it("holds nothing until an archive is saved, then gives back its bytes however they arrived", async () => {
		const { disk, rows } = makeDisk()
		expect(disk.read()).toBeUndefined()
		const archive = patterned(2 * 1024 * 1024 + 300, 1)
		await disk.replace(
			whole(archive.subarray(0, 10), archive.subarray(10, 1_500_000), archive.subarray(1_500_000)),
		)
		expect(await read(disk)).toEqual({ bytes: archive, compressed: true })
		expect(rows()).toEqual([
			{ generation: 1, part: -1, size: 1 },
			{ generation: 1, part: 0, size: 1024 * 1024 },
			{ generation: 1, part: 1, size: 1024 * 1024 },
			{ generation: 1, part: 2, size: 300 },
		])
	})

	it("replaces the saved archive only once the new one is whole", async () => {
		const { disk, rows } = makeDisk()
		const first = patterned(1000, 1)
		const second = patterned(3000, 2)
		await disk.replace(whole(first))
		const cutShort = async function* (): AsyncGenerator<Uint8Array> {
			yield second
			throw new Error("the machine stopped")
		}
		await expect(disk.replace({ chunks: cutShort(), compressed: true })).rejects.toThrow(
			"the machine stopped",
		)
		expect(await read(disk)).toEqual({ bytes: first, compressed: true })
		await disk.replace({ chunks: of(second), compressed: false })
		expect(await read(disk)).toEqual({ bytes: second, compressed: false })
		expect(rows()).toEqual([
			{ generation: 2, part: -1, size: 1 },
			{ generation: 2, part: 0, size: 3000 },
		])
		await disk.replace(whole())
		expect(await read(disk)).toEqual({ bytes: new Uint8Array(), compressed: true })
	})

	it("is gone when the workspace's storage is purged", async () => {
		const { disk, sql, rows } = makeDisk()
		await disk.replace(whole(patterned(1000, 1)))
		purgeTables({ exec: (query) => sql.exec(query) })
		expect(rows()).toEqual([])
		expect(disk.read()).toBeUndefined()
	})

	it("cuts bytes into pieces of one size, the last one shorter", async () => {
		const pieces: Array<number> = []
		for await (const piece of inPieces(of(patterned(5, 0), patterned(9, 0), patterned(1, 0)), 4)) {
			pieces.push(piece.byteLength)
		}
		expect(pieces).toEqual([4, 4, 4, 3])
	})
})
