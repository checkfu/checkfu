import * as Digest from "effect/crypto/Digest"
import type * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { ArtifactVersionNotReady } from "../Api.ts"
import type { ArtifactManifest } from "../Artifacts/ArtifactFiles.ts"
import type { ArtifactReaderService, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import { CONTENT_PATH_PREFIX, verifyLink } from "./ArtifactLink.ts"

export const CONTENT_SECURITY_POLICY = [
	"sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock",
	"base-uri 'none'",
	"object-src 'none'",
	"form-action 'none'",
].join("; ")

export const CONTENT_HEADERS = {
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"access-control-allow-origin": "*",
	"cross-origin-resource-policy": "cross-origin",
	"cache-control": "private, no-store",
	"x-robots-tag": "noindex",
} as const

const INDEX_FILE = "index.html"

const FILE_CACHE_CONTROL = "private, no-cache"

const matchesETag = (ifNoneMatch: string | undefined, etag: string) =>
	ifNoneMatch !== undefined &&
	ifNoneMatch.split(",").some((candidate) => {
		const tag = candidate.trim()
		return tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag
	})

const plain = (status: number, message: string) =>
	HttpServerResponse.text(message, { status, headers: CONTENT_HEADERS })

const notFound = plain(404, "Not found.")

const TEXT_TYPE =
	/^(?:text\/|application\/(?:javascript|json|xml)$|image\/svg\+xml$|[^;]+\+(?:json|xml)$)/i

const withCharset = (contentType: string) =>
	TEXT_TYPE.test(contentType) && !/charset=/i.test(contentType)
		? `${contentType}; charset=utf-8`
		: contentType

const decodePath = (encoded: string): string | null => {
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

const escapeHtml = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")

const folderEntries = (manifest: ArtifactManifest, folder: string) => {
	const entries = new Set<string>()
	for (const { path } of manifest.files) {
		if (path.startsWith(folder)) {
			const rest = path.slice(folder.length)
			const slash = rest.indexOf("/")
			entries.add(slash === -1 ? rest : rest.slice(0, slash + 1))
		}
	}
	return [...entries].toSorted()
}

const folderListing = (folder: string, entries: ReadonlyArray<string>) => {
	const title = escapeHtml(`/${folder}`)
	const items = entries.map((entry) => {
		const name = entry.endsWith("/") ? entry.slice(0, -1) : entry
		const href = `${encodeURIComponent(name)}${entry.endsWith("/") ? "/" : ""}`
		return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry)}</a></li>`
	})
	return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><ul>${items.join("")}</ul>`
}

const utf8Encoder = new TextEncoder()
const LISTING_TYPE = "text/html; charset=utf-8"

export interface ContentRequest {
	readonly method: string
	readonly url: string
	readonly ifNoneMatch?: string | undefined
}

export const contentRequestOf = (request: HttpServerRequest.HttpServerRequest): ContentRequest => ({
	method: request.method,
	url: request.originalUrl,
	ifNoneMatch: request.headers["if-none-match"],
})

export const serveContent = (options: {
	readonly mac: Mac.Mac["Service"]
	readonly digest: Digest.Digest["Service"]
	readonly key: Mac.Key
	readonly store: ArtifactReaderService
	readonly resolveArtifactVersion: (
		artifactId: string,
		version: number,
	) => Effect.Effect<string | null, ArtifactStoreError | ArtifactVersionNotReady>
	readonly scope: string
	readonly nowMillis: Effect.Effect<number>
}) => {
	const { mac, digest, key, store, resolveArtifactVersion, scope, nowMillis } = options
	return (request: ContentRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
		Effect.gen(function* () {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return plain(405, "Method not allowed.")
			}
			const url = URL.parse(request.url)
			if (url === null || !url.pathname.startsWith(CONTENT_PATH_PREFIX)) {
				return notFound
			}
			const { pathname, search } = url
			const toFolder = HttpServerResponse.empty({
				status: 308,
				headers: { ...CONTENT_HEADERS, location: `${pathname}/${search}` },
			})
			const rest = pathname.slice(CONTENT_PATH_PREFIX.length)
			const slash = rest.indexOf("/")
			if (slash === -1) {
				return rest.length === 0 ? notFound : toFolder
			}
			const claims = yield* verifyLink(mac, key, rest.slice(0, slash), yield* nowMillis)
			const requested = decodePath(rest.slice(slash + 1))
			if (claims === null || claims.scope !== scope || requested === null) {
				return notFound
			}
			const manifestHash = yield* resolveArtifactVersion(claims.artifactId, claims.version)
			if (manifestHash === null) {
				return notFound
			}
			const manifest = yield* store.getManifest(claims.artifactId, manifestHash)
			if (manifest === null) {
				return notFound
			}
			const isFolder = requested === "" || requested.endsWith("/")
			const path = isFolder ? `${requested}${INDEX_FILE}` : requested
			const file = manifest.files.find((entry) => entry.path === path)
			if (file === undefined) {
				if (!isFolder) {
					return manifest.files.some((entry) => entry.path.startsWith(`${requested}/`))
						? toFolder
						: notFound
				}
				const entries = folderEntries(manifest, requested)
				if (entries.length === 0) {
					return notFound
				}
				const listing = utf8Encoder.encode(folderListing(requested, entries))
				return request.method === "HEAD"
					? HttpServerResponse.empty({
							status: 200,
							headers: {
								...CONTENT_HEADERS,
								"content-type": LISTING_TYPE,
								"content-length": String(listing.byteLength),
							},
						})
					: HttpServerResponse.uint8Array(listing, {
							status: 200,
							contentType: LISTING_TYPE,
							headers: CONTENT_HEADERS,
						})
			}
			const contentType = withCharset(file.content_type)
			const typeDigest = yield* digest.digestHex(Digest.sha256, utf8Encoder.encode(contentType))
			const fileHeaders = {
				...CONTENT_HEADERS,
				"cache-control": FILE_CACHE_CONTROL,
				etag: `"${file.sha256}-${typeDigest.slice(0, 16)}"`,
			}
			if (matchesETag(request.ifNoneMatch, fileHeaders.etag)) {
				return HttpServerResponse.empty({ status: 304, headers: fileHeaders })
			}
			if (request.method === "HEAD") {
				return (yield* store.hasBlob(claims.artifactId, file.sha256))
					? HttpServerResponse.empty({
							status: 200,
							headers: {
								...fileHeaders,
								"content-type": contentType,
								"content-length": String(file.size),
							},
						})
					: notFound
			}
			const bytes = yield* store.getBlob(claims.artifactId, file.sha256)
			if (bytes === null) {
				return notFound
			}
			return HttpServerResponse.uint8Array(bytes, {
				status: 200,
				contentType,
				headers: fileHeaders,
			})
		}).pipe(
			Effect.catchTags({
				ArtifactStoreError: (error) =>
					Effect.as(
						Effect.logError("Artifact storage failed while serving content", error),
						plain(503, "Storage is unavailable. Try again."),
					),
				ArtifactVersionNotReady: () =>
					Effect.succeed(
						HttpServerResponse.text("This version is not ready yet. Try again.", {
							status: 503,
							headers: { ...CONTENT_HEADERS, "retry-after": "1" },
						}),
					),
			}),
		)
}
