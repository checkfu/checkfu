export const readResponseBytes = async (
	body: ReadableStream<Uint8Array>,
	limit: number,
	tooLarge = "Download exceeds the supported size.",
): Promise<Uint8Array<ArrayBuffer>> => {
	const chunks: Array<Uint8Array> = []
	const reader = body.getReader()
	let size = 0
	try {
		for (;;) {
			const next = await reader.read()
			if (next.done) {
				break
			}
			const length = next.value.byteLength
			size += length
			if (size > limit) {
				void reader.cancel().catch(() => undefined)
				throw new Error(tooLarge)
			}
			if (length > 0) {
				chunks.push(next.value)
			}
		}
	} finally {
		reader.releaseLock()
	}
	const result = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.byteLength
	}
	return result
}
