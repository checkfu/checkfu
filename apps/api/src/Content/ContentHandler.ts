import * as Digest from "effect/crypto/Digest"
import type * as Mac from "effect/crypto/Mac"
import * as Effect from "effect/Effect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { ArtifactVersionNotReady, ResolvedPublication } from "../Api.ts"
import type { ArtifactManifest } from "../Artifacts/ArtifactFiles.ts"
import type { ArtifactReaderService, ArtifactStoreError } from "../Artifacts/ArtifactStore.ts"
import {
	CONTENT_PATH_PREFIX,
	PUBLICATION_PATH_PREFIX,
	isPublicationAddress,
	publicationOfHost,
	verifyLink,
} from "./ArtifactLink.ts"

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
	"access-control-expose-headers": "etag",
	"cross-origin-resource-policy": "cross-origin",
	"cache-control": "private, no-store",
	"x-robots-tag": "noindex",
} as const

const ALLOWED_METHODS = "GET, HEAD, OPTIONS"

const PREFLIGHT_HEADERS = {
	...CONTENT_HEADERS,
	allow: ALLOWED_METHODS,
	"access-control-allow-methods": ALLOWED_METHODS,
	"access-control-allow-headers": "*",
	"access-control-max-age": "86400",
}

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
	readonly headers?: Readonly<Record<string, string | undefined>> | undefined
}

export type ContentAccessTarget =
	| {
			readonly kind: "publication"
			readonly address: string
			readonly artifactId: string
	  }
	| {
			readonly kind: "artifact_link"
			readonly artifactId: string
			readonly version: number
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
	readonly resolvePublication: (
		address: string,
	) => Effect.Effect<ResolvedPublication | null, ArtifactStoreError | ArtifactVersionNotReady>
	readonly scope: string
	readonly publishDomain?: string | undefined
	readonly nowMillis: Effect.Effect<number>
	readonly authorize?: (
		target: ContentAccessTarget,
		request: ContentRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse | null>
}) => {
	const {
		mac,
		digest,
		key,
		store,
		resolveArtifactVersion,
		resolvePublication,
		scope,
		publishDomain,
		nowMillis,
		authorize,
	} = options

	const target = (prefix: string, name: string) =>
		Effect.gen(function* () {
			if (prefix === PUBLICATION_PATH_PREFIX) {
				if (!isPublicationAddress(name)) {
					return null
				}
				const found = yield* resolvePublication(name)
				return found === null
					? null
					: {
							access: {
								kind: "publication" as const,
								address: name,
								artifactId: found.artifact_id,
							},
							artifactId: found.artifact_id,
							manifest: found.manifest,
						}
			}
			const claims = yield* verifyLink(mac, key, name, yield* nowMillis)
			if (claims === null || claims.scope !== scope) {
				return null
			}
			const manifest = yield* resolveArtifactVersion(claims.artifactId, claims.version)
			return manifest === null
				? null
				: {
						access: {
							kind: "artifact_link" as const,
							artifactId: claims.artifactId,
							version: claims.version,
						},
						artifactId: claims.artifactId,
						manifest,
					}
		})

	return (request: ContentRequest): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
		Effect.gen(function* () {
			if (request.method === "OPTIONS") {
				return HttpServerResponse.empty({ status: 204, headers: PREFLIGHT_HEADERS })
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				return HttpServerResponse.text("Method not allowed.", {
					status: 405,
					headers: { ...CONTENT_HEADERS, allow: ALLOWED_METHODS },
				})
			}
			const url = URL.parse(request.url)
			if (url === null) {
				return notFound
			}
			const { pathname, search } = url
			const hosted = publicationOfHost(url.hostname, publishDomain)
			const prefix =
				hosted === undefined
					? [CONTENT_PATH_PREFIX, PUBLICATION_PATH_PREFIX].find((candidate) =>
							pathname.startsWith(candidate),
						)
					: PUBLICATION_PATH_PREFIX
			if (prefix === undefined) {
				return notFound
			}
			const toFolder = HttpServerResponse.empty({
				status: 308,
				headers: { ...CONTENT_HEADERS, location: `${pathname}/${search}` },
			})
			const rest = hosted === undefined ? pathname.slice(prefix.length) : `${hosted}${pathname}`
			const slash = rest.indexOf("/")
			if (slash === -1) {
				return rest.length === 0 ? notFound : toFolder
			}
			const found = yield* target(prefix, rest.slice(0, slash))
			const requested = decodePath(rest.slice(slash + 1))
			if (found === null || requested === null) {
				return notFound
			}
			if (authorize !== undefined) {
				const denied = yield* authorize(found.access, request)
				if (denied !== null) {
					return denied
				}
			}
			const manifest = yield* store.getManifest(found.artifactId, found.manifest)
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
				return (yield* store.hasBlob(found.artifactId, file.sha256))
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
			const body = yield* store.blobStream(found.artifactId, file.sha256)
			if (body === null) {
				return notFound
			}
			return HttpServerResponse.stream(body, {
				status: 200,
				contentType,
				contentLength: file.size,
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
