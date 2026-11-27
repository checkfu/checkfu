export interface ByteRange {
	readonly offset: number
	readonly length: number
}

const singleRange = /^bytes=([0-9]*)-([0-9]*)$/iu

export const requestedRange = (
	header: string | undefined,
	ifRange: string | undefined,
	etag: string,
	size: number,
): ByteRange | "unsatisfiable" | undefined => {
	if (header === undefined || (ifRange !== undefined && ifRange !== etag)) {
		return undefined
	}
	const match = singleRange.exec(header.trim())
	if (match === null) {
		return undefined
	}
	const [, start = "", end = ""] = match
	const total = BigInt(size)
	if (start === "") {
		if (end === "") {
			return undefined
		}
		const suffix = BigInt(end)
		const length = Number(suffix < total ? suffix : total)
		return length === 0 ? "unsatisfiable" : { offset: size - length, length }
	}
	const offset = BigInt(start)
	const last = end === "" ? null : BigInt(end)
	if (last !== null && last < offset) {
		return undefined
	}
	if (offset >= total) {
		return "unsatisfiable"
	}
	const stop = last === null || last >= total ? total : last + 1n
	return { offset: Number(offset), length: Number(stop - offset) }
}

export const contentRange = (range: ByteRange, size: number): string =>
	`bytes ${range.offset}-${range.offset + range.length - 1}/${size}`

export const matchesETag = (ifNoneMatch: string | undefined, etag: string): boolean =>
	ifNoneMatch !== undefined &&
	ifNoneMatch.split(",").some((candidate) => {
		const tag = candidate.trim()
		return tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag
	})
