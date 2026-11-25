export interface Archive {
	readonly chunks: AsyncIterable<Uint8Array>
	readonly compressed: boolean
}

export interface SavedDisk {
	readonly read: () => ReadonlyArray<Archive> | undefined
	readonly replace: (archive: Archive) => Promise<void>
	readonly append: (archive: Archive) => Promise<void>
}

type Stored = number | bigint | string | null | ArrayBuffer | Uint8Array

export interface DiskSql {
	readonly exec: (
		query: string,
		...bindings: ReadonlyArray<number | Uint8Array>
	) => Iterable<Readonly<Record<string, Stored>>>
	readonly atomically: (work: () => void) => void
}

export async function* inPieces(
	chunks: AsyncIterable<Uint8Array>,
	size: number,
): AsyncGenerator<Uint8Array> {
	let piece = new Uint8Array(size)
	let filled = 0
	for await (const chunk of chunks) {
		let taken = 0
		while (taken < chunk.byteLength) {
			const fits = Math.min(size - filled, chunk.byteLength - taken)
			piece.set(chunk.subarray(taken, taken + fits), filled)
			filled += fits
			taken += fits
			if (filled === size) {
				yield piece
				piece = new Uint8Array(size)
				filled = 0
			}
		}
	}
	if (filled > 0) {
		yield piece.subarray(0, filled)
	}
}

const ROW_BYTES = 1024 * 1024
const SEAL = -1

const bytesOf = (value: Stored | undefined): Uint8Array | undefined =>
	typeof value === "object" && value !== null ? new Uint8Array(value) : undefined

export const makeSavedDisk = (sql: DiskSql): SavedDisk => {
	sql.exec(
		"CREATE TABLE IF NOT EXISTS machine_disk (generation INTEGER NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (generation, part))",
	)
	const sealed = (): ReadonlyArray<{ readonly generation: number; readonly compressed: boolean }> =>
		[
			...sql.exec(
				"SELECT generation, bytes FROM machine_disk WHERE part = ? ORDER BY generation",
				SEAL,
			),
		].flatMap((row) => {
			const generation = row["generation"]
			return typeof generation === "number"
				? [{ generation, compressed: bytesOf(row["bytes"])?.[0] === 1 }]
				: []
		})
	async function* rows(generation: number): AsyncGenerator<Uint8Array> {
		for (let part = 0; ; part += 1) {
			const [row] = [
				...sql.exec(
					"SELECT bytes FROM machine_disk WHERE generation = ? AND part = ?",
					generation,
					part,
				),
			]
			const bytes = bytesOf(row?.["bytes"])
			if (bytes === undefined) {
				return
			}
			yield bytes
		}
	}
	const store = async (archive: Archive, settle: (generation: number) => void): Promise<void> => {
		const latest = sealed().at(-1)?.generation ?? 0
		const next = latest + 1
		sql.exec("DELETE FROM machine_disk WHERE generation > ?", latest)
		let part = 0
		for await (const piece of inPieces(archive.chunks, ROW_BYTES)) {
			sql.exec("INSERT INTO machine_disk VALUES (?, ?, ?)", next, part, piece)
			part += 1
		}
		sql.atomically(() => {
			sql.exec(
				"INSERT INTO machine_disk VALUES (?, ?, ?)",
				next,
				SEAL,
				Uint8Array.of(archive.compressed ? 1 : 0),
			)
			settle(next)
		})
	}
	return {
		read: () => {
			const archives = sealed()
			return archives.length === 0
				? undefined
				: archives.map(({ generation, compressed }) => ({ chunks: rows(generation), compressed }))
		},
		replace: (archive) =>
			store(archive, (generation) => {
				sql.exec("DELETE FROM machine_disk WHERE generation < ?", generation)
			}),
		append: (archive) => store(archive, () => undefined),
	}
}
