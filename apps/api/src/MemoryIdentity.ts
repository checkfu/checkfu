import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"

const utf8Encoder = new TextEncoder()

/** The hash a memory is compared by, and the size it is limited by, over its UTF-8 bytes. */
export const measureContent = (digest: Digest.Digest["Service"], content: string) => {
	const bytes = utf8Encoder.encode(content)
	return Effect.map(digest.digestHex(Digest.sha256, bytes), (content_sha256) => ({
		content_sha256,
		content_size_bytes: bytes.length,
	}))
}

// One path in a store is one memory, so its id is a function of the two.
export const memoryIdOf = (
	digest: Digest.Digest["Service"],
	memoryStoreId: string,
	path: string,
): Effect.Effect<string> =>
	Effect.map(
		digest.digestHex(Digest.sha256, utf8Encoder.encode(JSON.stringify([memoryStoreId, path]))),
		(hash) => `mem_${hash.slice(0, 32)}`,
	)
