import { describe, expect, it } from "vitest"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactVersionView } from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { ArtifactStore } from "../src/Artifacts/ArtifactStore.ts"
import { ArtifactVersionResolver } from "../src/Artifacts/ResolveArtifactVersion.ts"
import { PublicationResolver } from "../src/Artifacts/ResolvePublication.ts"
import { linkKey, parsePublicationAddress } from "../src/Content/ArtifactLink.ts"
import {
	TEST_CONTENT_ORIGIN,
	TEST_LINK_SECRET,
	artifactLinksFor,
} from "../src/Content/ArtifactLinks.ts"
import { CONTENT_HEADERS, contentRequestOf, serveContent } from "../src/Content/ContentHandler.ts"
import { keyedArtifactId } from "../src/Http/ArtifactsHandlers.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { DEFAULT_STORAGE_SCOPE } from "../src/Placement.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const MacLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))

const webRequest = (url: string, method = "GET", ifNoneMatch?: string) =>
	contentRequestOf(
		HttpServerRequest.fromWeb(
			new Request(url, {
				method,
				headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
			}),
		),
	)

const PUBLISH_DOMAIN = "publish.test"

const ADDRESS = /^a[0-9a-f]{1,32}-[0-9a-z]{25}$/

// The address of the same artifact with a token it never held.
const forged = (address: string) => `${address.slice(0, -25)}${"0".repeat(25)}`

interface PublicationBody {
	readonly address: string
	readonly url: string
	readonly version: number | null
	readonly published_at: string
}

interface ArtifactBody {
	readonly id: string
	readonly version: number
	readonly files: ReadonlyArray<{ readonly path: string }>
	readonly publication: PublicationBody | null
}

type Api = (
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
) => Effect.Effect<Response>

type Handler = Effect.Success<typeof makeApiHandler>

const withPublishing = <A>(
	run: (tools: {
		readonly api: Api
		readonly open: (url: string, ifNoneMatch?: string) => Effect.Effect<Response>
		readonly openOnDomain: (
			url: string,
			options?: { readonly method?: string; readonly ifNoneMatch?: string },
		) => Effect.Effect<Response>
		readonly harness: ReturnType<typeof makePiDurableTestLayer>
		readonly lookups: {
			readonly served: ReadonlyArray<string>
			readonly read: ReadonlyArray<unknown>
			readonly resolve: Effect.Success<typeof PublicationResolver>
		}
		readonly through: (handler: Handler) => Api
		readonly provided: <B>(
			effect: Effect.Effect<B, never, Effect.Services<typeof makeApiHandler>>,
		) => Effect.Effect<B>
	}) => Effect.Effect<A>,
) => {
	const harness = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	const through =
		(handler: Handler): Api =>
		(method, path, body, headers) =>
			sendRequest(handler.fetch, {
				method,
				path,
				headers: { ...AUTH_HEADERS, ...headers },
				...(body === undefined ? {} : { body }),
			})
	return Effect.runPromise(
		Effect.gen(function* () {
			const handler = yield* makeApiHandler
			const artifacts = yield* Artifact
			const served: Array<string> = []
			const read: Array<unknown> = []
			const resolve = yield* PublicationResolver.pipe(
				Effect.provideService(Artifact, {
					...artifacts,
					get: (target) => {
						read.push(target)
						return artifacts.get(target)
					},
				}),
			)
			const serving = {
				mac: yield* Mac.Mac,
				digest: yield* Digest.Digest,
				key: yield* Effect.orDie(linkKey(TEST_LINK_SECRET)),
				store: yield* ArtifactStore,
				resolveArtifactVersion: yield* ArtifactVersionResolver,
				resolvePublication: (publicationId: string) => {
					served.push(publicationId)
					return resolve(publicationId)
				},
				scope: DEFAULT_STORAGE_SCOPE,
				nowMillis: Clock.currentTimeMillis,
			}
			const serve = serveContent(serving)
			const serveOnDomain = serveContent({ ...serving, publishDomain: PUBLISH_DOMAIN })
			const services = yield* Effect.context<Effect.Services<typeof makeApiHandler>>()
			return yield* run({
				api: through(handler),
				open: (url, ifNoneMatch) =>
					Effect.map(serve(webRequest(url, "GET", ifNoneMatch)), HttpServerResponse.toWeb),
				openOnDomain: (url, options) =>
					Effect.map(
						serveOnDomain(webRequest(url, options?.method, options?.ifNoneMatch)),
						HttpServerResponse.toWeb,
					),
				harness,
				lookups: { served, read, resolve },
				through,
				provided: (effect) => Effect.provide(effect, services),
			})
		}).pipe(
			Effect.scoped,
			Effect.provide([harness.layer, MacLive, Digest.layerWebCrypto]),
			Effect.ensuring(Effect.promise(harness.closeAll)),
		),
	)
}

const json = <T>(response: Response) => Effect.promise(() => response.json() as Promise<T>)
const text = (response: Response) => Effect.promise(() => response.text())

const createArtifact = (api: Api, content: string) =>
	Effect.map(
		Effect.flatMap(
			api("POST", "/v1/artifacts", {
				name: "Page",
				files: [
					{ path: "index.html", content },
					{ path: "about/index.html", content: `${content} about` },
				],
			}),
			(response) => json<ArtifactBody>(response),
		),
		(artifact) => artifact.id,
	)

const addVersion = (api: Api, id: string, version: number, content: string) =>
	Effect.map(
		api("POST", `/v1/artifacts/${id}/versions`, {
			version,
			files: [{ path: "index.html", content }],
		}),
		(response) => expect(response.status).toBe(201),
	)

const publish = (api: Api, id: string, body: unknown = {}) =>
	Effect.gen(function* () {
		const response = yield* api("POST", `/v1/artifacts/${id}/publication`, body)
		expect(response.status).toBe(200)
		const artifact = yield* json<ArtifactBody>(response)
		if (artifact.publication === null) {
			throw new Error("not published")
		}
		return artifact.publication
	})

describe("Publishing an artifact", () => {
	it("serves a pinned version or the latest one at an address that republishing keeps", () =>
		withPublishing(({ api, open }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				expect(
					(yield* json<ArtifactBody>(yield* api("GET", `/v1/artifacts/${id}`))).publication,
				).toBe(null)

				const pinned = yield* publish(api, id, { version: 1 })
				expect(pinned.address).toMatch(ADDRESS)
				expect(pinned.url).toBe(`${TEST_CONTENT_ORIGIN}/p/${pinned.address}/`)
				expect(pinned.version).toBe(1)
				expect(Number.isNaN(Date.parse(pinned.published_at))).toBe(false)
				expect(
					(yield* json<ArtifactBody>(yield* api("GET", `/v1/artifacts/${id}`))).publication,
				).toEqual(pinned)
				const url = pinned.url

				const home = yield* open(url)
				expect(home.status).toBe(200)
				expect(yield* text(home)).toBe("one")
				expect(home.headers.get("content-security-policy")).toBe(
					CONTENT_HEADERS["content-security-policy"],
				)
				expect(home.headers.get("content-security-policy")).not.toContain("allow-same-origin")
				expect(yield* text(yield* open(`${url}about/`))).toBe("one about")
				const bare = yield* open(`${TEST_CONTENT_ORIGIN}/p/${pinned.address}`)
				expect(bare.status).toBe(308)
				expect(bare.headers.get("location")).toBe(`/p/${pinned.address}/`)

				yield* addVersion(api, id, 1, "two")
				expect(yield* text(yield* open(url))).toBe("one")

				const latest = yield* publish(api, id)
				expect(latest).toMatchObject({ address: pinned.address, url, version: null })
				expect(yield* text(yield* open(url))).toBe("two")
				expect((yield* open(`${url}about/`)).status).toBe(404)
				expect(yield* publish(api, id, { version: "latest" })).toEqual(latest)

				yield* addVersion(api, id, 2, "three")
				expect(yield* text(yield* open(url))).toBe("three")

				expect(yield* publish(api, id, { version: 1 })).toMatchObject({ url, version: 1 })
				expect(yield* text(yield* open(url))).toBe("one")
			}),
		))

	it("serves a publication at the root of its own hostname when a publish domain is set", () =>
		withPublishing(({ api, openOnDomain, lookups, provided, through }) =>
			Effect.gen(function* () {
				const onDomain = through(
					yield* provided(
						makeApiHandler.pipe(
							Effect.provide(
								artifactLinksFor(
									TEST_CONTENT_ORIGIN,
									TEST_LINK_SECRET,
									DEFAULT_STORAGE_SCOPE,
									PUBLISH_DOMAIN,
								).pipe(Layer.provide(MacLive)),
							),
						),
					),
				)
				const id = yield* createArtifact(api, "one")
				const published = yield* publish(onDomain, id)
				expect(published.address).toMatch(ADDRESS)
				expect(published.url).toBe(`https://${published.address}.${PUBLISH_DOMAIN}/`)
				const { url } = published

				const home = yield* openOnDomain(url)
				expect(home.status).toBe(200)
				expect(yield* text(home)).toBe("one")
				expect(home.headers.get("content-security-policy")).toBe(
					CONTENT_HEADERS["content-security-policy"],
				)
				const etag = home.headers.get("etag") ?? ""
				expect(etag).not.toBe("")
				expect((yield* openOnDomain(url, { ifNoneMatch: etag })).status).toBe(304)
				const head = yield* openOnDomain(url, { method: "HEAD" })
				expect([head.status, head.headers.get("content-length")]).toEqual([200, "3"])
				expect(yield* text(yield* openOnDomain(`${url}about/index.html`))).toBe("one about")
				expect(yield* text(yield* openOnDomain(`${url}about/`))).toBe("one about")
				expect(
					yield* text(
						yield* openOnDomain(`https://${published.address.toUpperCase()}.Publish.Test/`),
					),
				).toBe("one")
				const bare = yield* openOnDomain(`${url}about?x=1`)
				expect(bare.status).toBe(308)
				expect(bare.headers.get("location")).toBe("/about/?x=1")

				const added = yield* api("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [
						{ path: "index.html", content: "two" },
						{ path: "a/index.html", content: "two a" },
						{ path: "assets/x.js", content: "x()" },
					],
				})
				expect(added.status).toBe(201)
				expect((yield* openOnDomain(`${url}about/`)).status).toBe(404)
				expect(yield* text(yield* openOnDomain(`${url}a/`))).toBe("two a")
				expect(webRequest(`${url}assets/x.js`).url).toBe(
					`https://${published.address}.${PUBLISH_DOMAIN}/assets/x.js`,
				)
				expect(yield* text(yield* openOnDomain(`${url}assets/x.js`))).toBe("x()")
				for (const other of [
					`https://${PUBLISH_DOMAIN}/`,
					`https://${PUBLISH_DOMAIN}/p/${published.address}/`,
					`https://a.${published.address}.${PUBLISH_DOMAIN}/`,
					`https://${published.address}.a.${PUBLISH_DOMAIN}/`,
					`https://${forged(published.address)}.${PUBLISH_DOMAIN}/`,
					`https://${published.address}x.${PUBLISH_DOMAIN}/`,
					`https://b${published.address.slice(1)}.${PUBLISH_DOMAIN}/`,
					`${url}p/${published.address}/`,
					`https://${published.address}.x${PUBLISH_DOMAIN}/`,
					`https://${published.address}.${PUBLISH_DOMAIN}.example/`,
				]) {
					const response = yield* openOnDomain(other)
					expect(response.status, other).toBe(404)
					expect(response.headers.get("content-security-policy"), other).toBe(
						CONTENT_HEADERS["content-security-policy"],
					)
				}
				for (const outside of [TEST_CONTENT_ORIGIN, `https://content.x${PUBLISH_DOMAIN}`]) {
					expect(yield* text(yield* openOnDomain(`${outside}/p/${published.address}/`))).toBe("two")
				}

				expect((yield* api("DELETE", `/v1/artifacts/${id}/publication`)).status).toBe(200)
				expect((yield* openOnDomain(url)).status).toBe(404)
				expect(lookups.served.filter((asked) => !ADDRESS.test(asked))).toEqual([])
			}),
		))

	it("refuses versions and artifacts that do not exist", () =>
		withPublishing(({ api, open, lookups }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				const status = (method: string, path: string, body?: unknown) =>
					Effect.map(api(method, path, body), (response) => response.status)
				expect(yield* status("POST", `/v1/artifacts/${id}/publication`, { version: 2 })).toBe(404)
				expect(yield* status("POST", `/v1/artifacts/${id}/publication`, { version: 0 })).toBe(400)
				expect(yield* status("POST", `/v1/artifacts/${id}/publication`, { version: "next" })).toBe(
					400,
				)
				expect(yield* status("POST", `/v1/artifacts/${id}/publication`, { slug: "x" })).toBe(400)
				expect(yield* status("POST", "/v1/artifacts/art_none/publication", {})).toBe(404)
				expect(yield* status("DELETE", "/v1/artifacts/art_none/publication")).toBe(404)
				expect(
					(yield* json<ArtifactBody>(yield* api("GET", `/v1/artifacts/${id}`))).publication,
				).toBe(null)

				const published = yield* publish(api, id)
				const wrong = forged(published.address)
				const tooLong = `a${"0".repeat(64)}-${"0".repeat(25)}`
				for (const path of [
					"/p/",
					"/p/missing/",
					`/p/${wrong}/`,
					`/p/${published.address.toUpperCase()}/`,
					`/p/${published.address}x/`,
					`/p/b${published.address.slice(1)}/`,
					`/p/${tooLong}/`,
					`/p/${published.address}/nope.js`,
					`/s/${published.address}/`,
					`/${published.address}/`,
				]) {
					const response = yield* open(`${TEST_CONTENT_ORIGIN}${path}`)
					expect(response.status, path).toBe(404)
					expect(response.headers.get("content-security-policy"), path).toBe(
						CONTENT_HEADERS["content-security-policy"],
					)
				}
				expect(lookups.served).toEqual([wrong, published.address])
				for (const malformed of ["", "missing", published.address.toUpperCase(), tooLong]) {
					expect(yield* Effect.orDie(lookups.resolve(malformed))).toBe(null)
				}
				expect(lookups.read).toEqual([id, id])
			}),
		))

	it("takes the address down at once on unpublish and never serves it again", () =>
		withPublishing(({ api, open }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				const first = yield* publish(api, id)
				expect((yield* open(first.url)).status).toBe(200)

				const unpublished = yield* api("DELETE", `/v1/artifacts/${id}/publication`)
				expect(unpublished.status).toBe(200)
				expect(yield* json<ArtifactBody>(unpublished)).toMatchObject({ id, publication: null })
				expect((yield* open(first.url)).status).toBe(404)
				const again = yield* api("DELETE", `/v1/artifacts/${id}/publication`)
				expect(again.status).toBe(200)
				expect(yield* json<ArtifactBody>(again)).toMatchObject({
					id,
					version: 1,
					publication: null,
				})

				const second = yield* publish(api, id)
				expect(second.address).not.toBe(first.address)
				expect(second.url).not.toBe(first.url)
				expect(yield* text(yield* open(second.url))).toBe("one")
				expect((yield* open(first.url)).status).toBe(404)
				yield* addVersion(api, id, 1, "two")
				expect((yield* open(first.url)).status).toBe(404)
				expect(yield* text(yield* open(second.url))).toBe("two")
			}),
		))

	it("names the artifact in the address and takes the token from the secure random", () =>
		withPublishing(({ api, open, provided, through }) =>
			Effect.gen(function* () {
				const one = yield* createArtifact(api, "one")
				const keyed = yield* json<ArtifactBody>(
					yield* api(
						"POST",
						"/v1/artifacts",
						{ name: "Keyed", files: [{ path: "index.html", content: "keyed" }] },
						{ "idempotency-key": "keyed-for-address" },
					),
				)
				expect(keyed.id).toBe(
					yield* Effect.flatMap(Digest.Digest, (digest) =>
						keyedArtifactId(digest, "keyed-for-address"),
					).pipe(Effect.provide(Digest.layerWebCrypto)),
				)
				for (const id of [one, keyed.id]) {
					const { address, url } = yield* publish(api, id)
					expect(address).toMatch(ADDRESS)
					expect(address.length).toBeLessThanOrEqual(63)
					expect(parsePublicationAddress(address)?.artifactId).toBe(id)
					expect((yield* open(url)).status).toBe(200)
				}

				const drawn: Array<Uint8Array> = []
				const seeded = yield* provided(
					makeApiHandler.pipe(
						Effect.provideService(
							SecureRandom.SecureRandom,
							SecureRandom.make((size) => {
								const bytes = new Uint8Array(size).fill(drawn.length + 1)
								drawn.push(bytes)
								return bytes
							}),
						),
					),
				)
				const third = yield* createArtifact(api, "third")
				const response = yield* through(seeded)("POST", `/v1/artifacts/${third}/publication`, {})
				const published = (yield* json<ArtifactBody>(response)).publication
				const wide = drawn.filter((bytes) => bytes.length >= 16)
				expect(wide.map((bytes) => bytes.length)).toEqual([16])
				const token = BigInt(`0x${Hex.encode(wide[0] ?? new Uint8Array())}`)
					.toString(36)
					.padStart(25, "0")
				expect(published?.address).toBe(`a${third.slice("art_".length)}-${token}`)
			}),
		))

	it("stops serving an artifact that is deleted, before its files are purged, whatever the ETag", () =>
		withPublishing(({ api, open, harness }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				const { url } = yield* publish(api, id)
				const page = yield* open(url)
				expect(page.status).toBe(200)
				const etag = page.headers.get("etag") ?? ""
				expect(etag).not.toBe("")
				expect((yield* open(url, etag)).status).toBe(304)

				const store = harness.artifactStore
				store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(503)
				store.setBeforeDelete(Effect.void)
				store.setFailing(false)
				expect([...store.objects.keys()].some((key) => key.includes("/manifests/"))).toBe(true)
				expect((yield* open(url)).status).toBe(404)
				expect((yield* open(url, etag)).status).toBe(404)
				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect((yield* open(url, etag)).status).toBe(404)
				expect((yield* api("POST", `/v1/artifacts/${id}/publication`, {})).status).toBe(404)
				expect((yield* api("DELETE", `/v1/artifacts/${id}/publication`)).status).toBe(404)
			}),
		))

	it("serves a committed publish or unpublish at once, though the request stopped right after it", () =>
		withPublishing(({ api, open, provided, through }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				const { url } = yield* publish(api, id, { version: 1 })
				yield* addVersion(api, id, 1, "two")
				const stopped = new Error("the Worker stopped")
				const stopping = yield* provided(
					Effect.gen(function* () {
						const artifacts = yield* Artifact
						return yield* makeApiHandler.pipe(
							Effect.provideService(Artifact, {
								...artifacts,
								send: (command, options) =>
									Effect.andThen(artifacts.send(command, options), Effect.die(stopped)),
							}),
						)
					}),
				)
				const status = (method: string, body?: unknown) =>
					Effect.map(
						through(stopping)(method, `/v1/artifacts/${id}/publication`, body),
						(response) => response.status,
					)
				expect(yield* status("POST", {})).toBe(500)
				expect(yield* text(yield* open(url))).toBe("two")
				expect(yield* status("DELETE")).toBe(500)
				expect((yield* open(url)).status).toBe(404)
				expect(
					(yield* json<ArtifactBody>(yield* api("GET", `/v1/artifacts/${id}`))).publication,
				).toBe(null)
			}),
		))

	it("reads the publication with the rest of the artifact from one read, never from a view", () =>
		withPublishing(({ api, provided, through }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				const published = yield* publish(api, id)
				let interleaved: Effect.Effect<void> = Effect.void
				const viewless = yield* provided(
					Effect.gen(function* () {
						const artifacts = yield* Artifact
						const versions = yield* ArtifactVersionView
						const touched = () => Effect.die(new Error("a head read touched a view"))
						const untouchable = { get: touched, snapshot: touched, waitFor: touched, list: touched }
						return yield* makeApiHandler.pipe(
							Effect.provideService(Artifact, {
								...artifacts,
								get: (target) =>
									Effect.tap(artifacts.get(target), () => {
										const run = interleaved
										interleaved = Effect.void
										return run
									}),
							}),
							Effect.provideService(ArtifactVersionView, { ...versions, ...untouchable }),
						)
					}),
				)
				interleaved = Effect.gen(function* () {
					expect((yield* api("DELETE", `/v1/artifacts/${id}/publication`)).status).toBe(200)
					yield* addVersion(api, id, 1, "two")
				})
				const read = yield* json<ArtifactBody>(
					yield* through(viewless)("GET", `/v1/artifacts/${id}`),
				)
				expect(read.version).toBe(1)
				expect(read.files.map((file) => file.path)).toEqual(["about/index.html", "index.html"])
				expect(read.publication).toEqual(published)
				const now = yield* json<ArtifactBody>(
					yield* through(viewless)("GET", `/v1/artifacts/${id}`),
				)
				expect([now.version, now.publication]).toEqual([2, null])
			}),
		))

	it("applies a keyed publish or unpublish once, so a retry never undoes a later call", () =>
		withPublishing(({ api, open }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				yield* addVersion(api, id, 1, "two")
				const path = `/v1/artifacts/${id}/publication`
				const call = (method: string, key: string, body?: unknown) =>
					Effect.flatMap(api(method, path, body, { "idempotency-key": key }), (response) =>
						Effect.map(json<ArtifactBody>(response), (artifact) => {
							expect(response.status).toBe(200)
							return artifact.publication
						}),
					)
				const current = Effect.map(
					Effect.flatMap(api("GET", `/v1/artifacts/${id}`), (response) =>
						json<ArtifactBody>(response),
					),
					(artifact) => artifact.publication,
				)

				const first = yield* call("POST", "publish-k", {})
				expect(yield* call("DELETE", "unpublish-after")).toBe(null)
				expect(yield* call("POST", "publish-k", {})).toBe(null)
				expect(yield* current).toBe(null)
				expect((yield* open(first?.url ?? "")).status).toBe(404)

				expect(yield* call("DELETE", "unpublish-k2")).toBe(null)
				const second = yield* call("POST", "publish-after", {})
				expect(yield* call("DELETE", "unpublish-k2")).toEqual(second)
				expect(yield* current).toEqual(second)
				expect(yield* text(yield* open(second?.url ?? ""))).toBe("two")

				expect(yield* call("POST", "pin-k3", { version: 1 })).toMatchObject({ version: 1 })
				expect(yield* call("POST", "pin-later", { version: 2 })).toMatchObject({ version: 2 })
				expect(yield* call("POST", "pin-k3", { version: 1 })).toMatchObject({ version: 2 })
				expect(yield* current).toMatchObject({ address: second?.address, version: 2 })

				expect(yield* call("POST", "pin-k4", { version: 1 })).toMatchObject({ version: 1 })
				expect(yield* call("DELETE", "unpublish-after-k4")).toBe(null)
				expect(yield* call("POST", "pin-k4", { version: 1 })).toBe(null)
				expect(yield* current).toBe(null)

				const plain = (method: string, body?: unknown) =>
					Effect.flatMap(api(method, path, body), (response) =>
						Effect.map(json<ArtifactBody>(response), (artifact) => artifact.publication),
					)
				expect(yield* plain("DELETE")).toBe(null)
				const unkeyed = yield* plain("POST", {})
				expect(yield* plain("DELETE")).toBe(null)
				expect((yield* plain("POST", {}))?.address).not.toBe(unkeyed?.address)

				expect(yield* call("DELETE", "shared")).toBe(null)
				expect((yield* api("POST", path, {}, { "idempotency-key": "shared" })).status).toBe(409)
				expect(yield* current).toBe(null)
			}),
		))

	it("refuses an Idempotency-Key reused for a different publish or unpublish", () =>
		withPublishing(({ api }) =>
			Effect.gen(function* () {
				const id = yield* createArtifact(api, "one")
				yield* addVersion(api, id, 1, "two")
				const path = `/v1/artifacts/${id}/publication`
				const send = (method: string, key: string, body?: unknown) =>
					api(method, path, body, { "idempotency-key": key })
				const current = Effect.map(
					Effect.flatMap(api("GET", `/v1/artifacts/${id}`), (response) =>
						json<ArtifactBody>(response),
					),
					(artifact) => artifact.publication,
				)
				const reused = (method: string, key: string, body?: unknown) =>
					Effect.gen(function* () {
						const response = yield* send(method, key, body)
						expect(response.status).toBe(409)
						expect(yield* json<unknown>(response)).toMatchObject({
							type: "error",
							error: {
								type: "conflict_error",
								message: "Idempotency-Key was already used for a different request.",
							},
						})
					})

				expect((yield* send("POST", "pin", { version: 1 })).status).toBe(200)
				yield* reused("POST", "pin", { version: 2 })
				yield* reused("POST", "pin", {})
				yield* reused("DELETE", "pin")
				expect(yield* current).toMatchObject({ version: 1 })
				expect((yield* send("POST", "pin", { version: 1 })).status).toBe(200)

				expect((yield* send("POST", "latest", {})).status).toBe(200)
				expect((yield* send("POST", "latest", { version: "latest" })).status).toBe(200)
				expect(yield* current).toMatchObject({ version: null })

				expect((yield* send("DELETE", "down")).status).toBe(200)
				yield* reused("POST", "down", {})
				expect(yield* current).toBe(null)
				expect((yield* send("DELETE", "down")).status).toBe(200)
			}),
		))

	it("replays a keyed create as it was answered, never published", () =>
		withPublishing(({ api, provided }) =>
			Effect.gen(function* () {
				const handler = yield* provided(makeApiHandler)
				const create = Effect.flatMap(
					sendRequest(handler.fetch, {
						method: "POST",
						path: "/v1/artifacts",
						headers: { ...AUTH_HEADERS, "idempotency-key": "create-once" },
						body: { name: "Page", files: [{ path: "index.html", content: "one" }] },
					}),
					(response) => json<ArtifactBody>(response),
				)
				const created = yield* create
				expect([created.version, created.publication]).toEqual([1, null])
				yield* addVersion(api, created.id, 1, "two")
				const published = yield* publish(api, created.id, { version: 2 })
				expect(published.version).toBe(2)
				const replayed = yield* create
				expect(replayed).toEqual(created)
				expect([replayed.version, replayed.publication]).toEqual([1, null])
			}),
		))
})
