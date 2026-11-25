import { describe, expect, it } from "vitest"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { WaitTimeout } from "@alchemy.run/domain"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { ArtifactVersionView } from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import { DeleteArtifact } from "@checkfu/domain/Artifact/DeleteArtifact.command"
import { ArtifactStore } from "../src/Artifacts/ArtifactStore.ts"
import { ArtifactVersionResolver } from "../src/Artifacts/ResolveArtifactVersion.ts"
import { PublicationResolver } from "../src/Artifacts/ResolvePublication.ts"
import type { ArtifactLinkClaims } from "../src/Content/ArtifactLink.ts"
import {
	DEFAULT_LINK_TTL_SECONDS,
	MAX_LINK_TTL_SECONDS,
	linkKey,
	signLink,
	verifyLink,
} from "../src/Content/ArtifactLink.ts"
import { TEST_CONTENT_ORIGIN, TEST_LINK_SECRET } from "../src/Content/ArtifactLinks.ts"
import { CONTENT_HEADERS, contentRequestOf, serveContent } from "../src/Content/ContentHandler.ts"
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

type ViewLag = "caught-up" | "catches-up" | "never"

const VERSION = 3
const NOW = 1_800_000_000
const NOW_MS = NOW * 1000
const GOLDEN_TOKEN =
	"ZGVmYXVsdC5hcnRfMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3LjcuMTgwMDAwMDAwMA.0Rai4HJ5nNmhHoc8udE9dc9AENS5VUIAEi_xWpjyCuE"

interface LinkBody {
	readonly type: string
	readonly artifact_id: string
	readonly version: number
	readonly url: string
	readonly expires_at: string
}

const withContent = <A>(
	run: (tools: {
		readonly api: (method: string, path: string, body?: unknown) => Effect.Effect<Response>
		readonly open: (url: string, method?: string, ifNoneMatch?: string) => Effect.Effect<Response>
		readonly openIn: (scope: string, url: string) => Effect.Effect<Response>
		readonly openLagging: (lag: ViewLag, url: string) => Effect.Effect<Response>
		readonly openUrl: (url: string) => Effect.Effect<Response>
		readonly sign: (claims: ArtifactLinkClaims) => Effect.Effect<string>
		readonly setNow: (millis: number) => void
		readonly store: ReturnType<typeof makePiDurableTestLayer>["artifactStore"]
		readonly artifacts: Effect.Success<typeof Artifact>
	}) => Effect.Effect<A>,
) => {
	const { layer, closeAll, artifactStore } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	return Effect.runPromise(
		Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			const mac = yield* Mac.Mac
			const digest = yield* Digest.Digest
			const key = yield* Effect.orDie(linkKey(TEST_LINK_SECRET))
			let now: number | undefined
			const store = yield* ArtifactStore
			const resolveArtifactVersion = yield* ArtifactVersionResolver
			const resolvePublication = yield* PublicationResolver
			const versionViews = yield* ArtifactVersionView
			const laggingResolver = (lag: ViewLag) =>
				ArtifactVersionResolver.pipe(
					Effect.provideService(ArtifactVersionView, {
						...versionViews,
						get: (ref, options) =>
							lag === "caught-up" ? versionViews.get(ref, options) : Effect.succeedNone,
						waitFor: (ref, where, options) =>
							lag === "never"
								? Effect.fail(new WaitTimeout({ view: "ArtifactVersionView", key: String(ref) }))
								: versionViews.waitFor(ref, where, options),
					}),
				)
			const lagging = {
				"caught-up": yield* laggingResolver("caught-up"),
				"catches-up": yield* laggingResolver("catches-up"),
				never: yield* laggingResolver("never"),
			}
			const serveWith = (
				scope: string,
				resolve: typeof resolveArtifactVersion = resolveArtifactVersion,
			) =>
				serveContent({
					mac,
					digest,
					key,
					store,
					resolveArtifactVersion: resolve,
					resolvePublication,
					scope,
					nowMillis: Effect.map(Clock.currentTimeMillis, (millis) => now ?? millis),
				})
			const serve = serveWith(DEFAULT_STORAGE_SCOPE)
			return yield* run({
				api: (method, path, body) =>
					sendRequest(apiFetch, {
						method,
						path,
						headers: AUTH_HEADERS,
						...(body === undefined ? {} : { body }),
					}),
				open: (url, method = "GET", ifNoneMatch) =>
					Effect.map(serve(webRequest(url, method, ifNoneMatch)), HttpServerResponse.toWeb),
				openIn: (scope, url) =>
					Effect.map(serveWith(scope)(webRequest(url)), HttpServerResponse.toWeb),
				openUrl: (url) => Effect.map(serve({ method: "GET", url }), HttpServerResponse.toWeb),
				openLagging: (lag, url) =>
					Effect.map(
						serveWith(DEFAULT_STORAGE_SCOPE, lagging[lag])(webRequest(url)),
						HttpServerResponse.toWeb,
					),
				sign: (claims) => signLink(mac, key, claims),
				setNow: (millis) => {
					now = millis
				},
				store: artifactStore,
				artifacts: yield* Artifact,
			})
		}).pipe(
			Effect.scoped,
			Effect.provide([layer, MacLive, Digest.layerWebCrypto]),
			Effect.ensuring(Effect.promise(closeAll)),
		),
	)
}

const json = <T>(response: Response) => Effect.promise(() => response.json() as Promise<T>)
const text = (response: Response) => Effect.promise(() => response.text())

const createArtifact = (
	api: (method: string, path: string, body?: unknown) => Effect.Effect<Response>,
	files: ReadonlyArray<{
		readonly path: string
		readonly content: string
		readonly content_type?: string
		readonly encoding?: string
	}>,
) =>
	Effect.flatMap(api("POST", "/v1/artifacts", { name: "Page", files }), (response) =>
		json<{ readonly id: string }>(response),
	)

const createLink = (
	api: (method: string, path: string, body?: unknown) => Effect.Effect<Response>,
	id: string,
	body: unknown = {},
) =>
	Effect.flatMap(api("POST", `/v1/artifacts/${id}/versions/1/links`, body), (response) =>
		json<LinkBody>(response),
	)

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const sameBytes = (last: string) => BASE64URL[BASE64URL.indexOf(last) ^ 1] ?? ""

const expectSandboxed = (response: Response, label: string) => {
	expect(response.headers.get("content-security-policy"), label).toBe(
		CONTENT_HEADERS["content-security-policy"],
	)
	expect(response.headers.get("x-content-type-options"), label).toBe("nosniff")
	expect(response.headers.get("referrer-policy"), label).toBe("no-referrer")
}

describe("Artifact link tokens", () => {
	const withKeys = <A>(
		run: (tools: {
			readonly mac: Mac.Mac["Service"]
			readonly key: Mac.Key
			readonly other: Mac.Key
		}) => Effect.Effect<A>,
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				return yield* run({
					mac: yield* Mac.Mac,
					key: yield* Effect.orDie(linkKey("one")),
					other: yield* Effect.orDie(linkKey("two")),
				})
			}).pipe(Effect.provide(MacLive)),
		)

	it("verifies what it signed and nothing else", () =>
		withKeys(({ mac, key, other }) =>
			Effect.gen(function* () {
				const claims = {
					scope: "eu",
					artifactId: `art_${"0123456789abcdef".repeat(2).slice(0, 24)}`,
					version: VERSION,
					expiresAt: NOW + 60,
				}
				const token = yield* signLink(mac, key, claims)
				expect(yield* verifyLink(mac, key, token, NOW_MS)).toEqual(claims)
				expect(yield* verifyLink(mac, key, token, (NOW + 60) * 1000 - 1)).toEqual(claims)
				expect(yield* verifyLink(mac, key, token, (NOW + 60) * 1000)).toBeNull()
				expect(yield* verifyLink(mac, other, token, NOW_MS)).toBeNull()

				const [payload = "", tag = ""] = token.split(".")
				const forgedClaims = Base64Url.encode(`eu.art_2.${VERSION}.${NOW + 60}`)
				const laterExpiry = Base64Url.encode(`eu.${claims.artifactId}.${VERSION}.${NOW + 6000}`)
				const otherScope = Base64Url.encode(`us.${claims.artifactId}.${VERSION}.${NOW + 60}`)
				const noScope = Base64Url.encode(`${claims.artifactId}.${VERSION}.${NOW + 60}`)
				expect(payload.length % 4).not.toBe(0)
				for (const bad of [
					`${forgedClaims}.${tag}`,
					`${laterExpiry}.${tag}`,
					`${otherScope}.${tag}`,
					`${noScope}.${tag}`,
					`${payload}.${Base64Url.encode("not the tag")}`,
					`${payload}.`,
					`${payload}`,
					`${payload}.${tag}.${tag}`,
					`.${tag}`,
					"",
					"%%%.%%%",
					`${payload}.${tag}=`,
					`${payload}=.${tag}`,
					`${payload}.${tag}\n`,
					`${payload}.${tag.slice(0, -1)}${sameBytes(tag.slice(-1))}`,
					`${payload.slice(0, -1)}${sameBytes(payload.slice(-1))}.${tag}`,
					`${payload}\n.${tag}`,
				]) {
					expect(yield* verifyLink(mac, key, bad, NOW_MS), bad).toBeNull()
				}
			}),
		))

	it("still verifies a token issued in the committed wire format", () =>
		withKeys(({ mac }) =>
			Effect.gen(function* () {
				const key = yield* Effect.orDie(linkKey("golden-link-secret"))
				const claims = {
					scope: "default",
					artifactId: "art_0123456789abcdef01234567",
					version: 7,
					expiresAt: 1_800_000_000,
				}
				expect(yield* verifyLink(mac, key, GOLDEN_TOKEN, NOW_MS - 1)).toEqual(claims)
				expect(yield* signLink(mac, key, claims)).toBe(GOLDEN_TOKEN)
			}),
		))
})

describe("Artifact viewing links", () => {
	it("serves the linked version with the sandbox headers on every response", () =>
		withContent(({ api, open, openUrl, store }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [
					{ path: "index.html", content: "<h1>home</h1>" },
					{ path: "app.js", content: "run()" },
					{ path: "docs/index.html", content: "<h1>docs</h1>" },
					{ path: "my file.txt", content: "spaced" },
					{ path: "latin.html", content: "x", content_type: "text/html; charset=iso-8859-1" },
					{ path: "data.json", content: "{}" },
					{ path: "dot.png", content: "iVBORw==", encoding: "base64" },
				])
				const link = yield* createLink(api, id)
				expect(link).toMatchObject({ type: "artifact_link", artifact_id: id, version: 1 })
				expect(link.url.startsWith(`${TEST_CONTENT_ORIGIN}/a/`)).toBe(true)
				expect(link.url.endsWith("/")).toBe(true)

				const home = yield* open(link.url)
				expect(home.status).toBe(200)
				expect(yield* text(home)).toBe("<h1>home</h1>")
				expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8")
				for (const [name, value] of Object.entries({
					...CONTENT_HEADERS,
					"cache-control": "private, no-cache",
				})) {
					expect(home.headers.get(name), name).toBe(value)
				}
				expect(home.headers.get("content-security-policy")).toBe(
					"sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; base-uri 'none'; object-src 'none'; form-action 'none'",
				)
				expect(home.headers.get("referrer-policy")).toBe("no-referrer")
				expect(home.headers.get("x-content-type-options")).toBe("nosniff")
				expect(home.headers.get("cache-control")).toBe("private, no-cache")
				expect(home.headers.get("etag")).toMatch(/^"[0-9a-f]{64}-[0-9a-f]{16}"$/)

				const served = (path: string) =>
					Effect.tap(open(`${link.url}${path}`), (response) =>
						Effect.sync(() => {
							expect(response.status, path).toBe(200)
							expectSandboxed(response, path)
						}),
					)
				const script = yield* served("app.js")
				expect(yield* text(script)).toBe("run()")
				expect(script.headers.get("content-type")).toMatch(/javascript; charset=utf-8$/)
				expect(yield* text(yield* served("docs/"))).toBe("<h1>docs</h1>")
				expect(yield* text(yield* served("my%20file.txt"))).toBe("spaced")
				expect((yield* served("latin.html")).headers.get("content-type")).toBe(
					"text/html; charset=iso-8859-1",
				)
				expect((yield* served("data.json")).headers.get("content-type")).toBe(
					"application/json; charset=utf-8",
				)
				expect((yield* served("dot.png")).headers.get("content-type")).toBe("image/png")

				const bare = yield* open(link.url.slice(0, -1))
				expect(bare.status).toBe(308)
				expect(bare.headers.get("location")).toBe(new URL(link.url).pathname)
				expectSandboxed(bare, "redirect to the link root")
				const folder = yield* open(`${link.url}docs`)
				expect(folder.status).toBe(308)
				expect(folder.headers.get("location")).toBe(`${new URL(link.url).pathname}docs/`)
				expectSandboxed(folder, "redirect to a folder")

				const head = yield* open(link.url, "HEAD")
				expect(head.status).toBe(200)
				expect(head.headers.get("content-length")).toBe(String("<h1>home</h1>".length))
				expectSandboxed(head, "HEAD")

				const preflight = yield* open(`${link.url}data.json`, "OPTIONS")
				expect(preflight.status).toBe(204)
				expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
				expect(preflight.headers.get("access-control-allow-headers")).toBe("*")
				expectSandboxed(preflight, "OPTIONS")
				const refused = yield* open(link.url, "POST")
				expect(refused.headers.get("allow")).toBe("GET, HEAD, OPTIONS")

				for (const [url, method, status] of [
					[`${link.url}missing.js`, "GET", 404],
					[`${link.url}%E0%A4%A`, "GET", 404],
					[`${TEST_CONTENT_ORIGIN}/`, "GET", 404],
					[`${TEST_CONTENT_ORIGIN}/v1/artifacts/${id}`, "GET", 404],
					[link.url, "POST", 405],
				] as const) {
					const response = yield* open(url, method)
					expect(response.status, `${method} ${url}`).toBe(status)
					expectSandboxed(response, `${method} ${url}`)
				}
				for (const url of ["//", "//x:99999/", new URL(link.url).pathname]) {
					const response = yield* openUrl(url)
					expect(response.status, url).toBe(404)
					expectSandboxed(response, url)
				}

				for (const key of store.objects.keys()) {
					if (key.includes("/blobs/")) {
						store.objects.delete(key)
					}
				}
				const gone = yield* open(`${link.url}app.js`)
				expect(gone.status).toBe(404)
				expectSandboxed(gone, "missing bytes")
			}),
		))

	it("stops serving when the link expires, is altered, or the artifact is deleted", () =>
		withContent(({ api, open, setNow, store }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "one" }])
				const other = yield* createArtifact(api, [{ path: "index.html", content: "two" }])
				const before = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const link = yield* createLink(api, id, { expires_in: 90 })
				const expires = Math.floor(Date.parse(link.expires_at) / 1000)
				expect(expires).toBeGreaterThanOrEqual(before + 90)
				expect(expires).toBeLessThanOrEqual(before + 92)

				setNow(expires * 1000 - 1)
				expect((yield* open(link.url)).status).toBe(200)
				setNow(expires * 1000)
				expect((yield* open(link.url)).status).toBe(404)
				setNow(expires * 1000 - 1)

				const [payload = "", tag = ""] = (new URL(link.url).pathname.split("/")[2] ?? "").split(".")
				const claims = Base64Url.decodeString(payload)
				const swapped = Base64Url.encode(
					(claims._tag === "Success" ? claims.success : "").replace(id, other.id),
				)
				expect((yield* open(`${TEST_CONTENT_ORIGIN}/a/${swapped}.${tag}/`)).status).toBe(404)
				expect((yield* open(`${TEST_CONTENT_ORIGIN}/a/${payload}.${tag}x/`)).status).toBe(404)

				store.setFailing(true)
				const down = yield* open(link.url)
				expect(down.status).toBe(503)
				expectSandboxed(down, "storage down")
				store.setFailing(false)

				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect((yield* open(link.url)).status).toBe(404)
				expect((yield* api("POST", `/v1/artifacts/${id}/versions/1/links`, {})).status).toBe(404)
			}),
		))

	it("stops serving a deleted artifact at once, and purges its files once storage recovers", () =>
		withContent(({ api, open, store }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "one" }])
				const link = yield* createLink(api, id)
				store.setBeforeDelete(Effect.sync(() => store.setFailing(true)))
				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(503)
				store.setBeforeDelete(Effect.void)
				const gone = yield* open(link.url)
				expect(gone.status).toBe(404)
				expectSandboxed(gone, "deleted")
				store.setFailing(false)
				for (let attempt = 0; attempt < 300 && store.objects.size > 0; attempt++) {
					yield* Effect.sleep("10 millis")
				}
				expect(store.objects.size).toBe(0)
			}),
		))

	it("stops serving the moment a delete commits, though its reply is lost and nothing else ran", () =>
		withContent(({ api, open, artifacts }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "one" }])
				const link = yield* createLink(api, id)
				const artifactId = ArtifactId.make(id)
				expect((yield* open(link.url)).status).toBe(200)

				yield* Effect.orDie(artifacts.send(new DeleteArtifact({ artifact_id: artifactId })))
				const gone = yield* open(link.url)
				expect(gone.status).toBe(404)
				expectSandboxed(gone, "committed delete")
				expect((yield* open(`${link.url}index.html`, "HEAD")).status).toBe(404)
			}),
		))

	it("lists a folder that has no index.html, with every name escaped", () =>
		withContent(({ api, open }) =>
			Effect.gen(function* () {
				const single = yield* createArtifact(api, [
					{ path: "report.pdf", content: "JVBERg==", encoding: "base64" },
				])
				const singleLink = yield* createLink(api, single.id)
				const root = yield* open(singleLink.url)
				expect(root.status).toBe(200)
				expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8")
				for (const [name, value] of Object.entries(CONTENT_HEADERS)) {
					expect(root.headers.get(name), name).toBe(value)
				}
				expect(root.headers.get("etag")).toBeNull()
				expect((yield* open(singleLink.url, "GET", "*")).status).toBe(200)
				expect(yield* text(root)).toContain('<a href="report.pdf">report.pdf</a>')
				const head = yield* open(singleLink.url, "HEAD")
				expect(head.status).toBe(200)
				expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(root.headers))

				const { id } = yield* createArtifact(api, [
					{ path: "<b>&.txt", content: "odd" },
					{ path: "docs/a b.md", content: "a" },
					{ path: "docs/deep/c.txt", content: "c" },
					{ path: "site/index.html", content: "<h1>site</h1>" },
					{ path: "site/other.html", content: "other" },
				])
				const link = yield* createLink(api, id)
				const top = yield* text(yield* open(link.url))
				expect(top).toContain('<a href="%3Cb%3E%26.txt">&lt;b&gt;&amp;.txt</a>')
				expect(top).toContain('<a href="docs/">docs/</a>')
				expect(top).toContain('<a href="site/">site/</a>')
				expect(top).not.toContain("<b>&")
				expect(top).not.toContain("deep")

				const docs = yield* open(`${link.url}docs/`)
				expect(docs.status).toBe(200)
				expectSandboxed(docs, "nested listing")
				const nested = yield* text(docs)
				expect(nested).toContain('<a href="a%20b.md">a b.md</a>')
				expect(nested).toContain('<a href="deep/">deep/</a>')
				expect(nested).not.toContain("txt")
				expect(yield* text(yield* open(`${link.url}docs/a%20b.md`))).toBe("a")
				const toDocs = yield* open(`${link.url}docs`)
				expect(toDocs.status).toBe(308)
				expect(toDocs.headers.get("location")).toBe(`${new URL(link.url).pathname}docs/`)
				expect(yield* text(yield* open(`${link.url}docs/deep/`))).toContain(
					'<a href="c.txt">c.txt</a>',
				)

				expect(yield* text(yield* open(`${link.url}site/`))).toBe("<h1>site</h1>")
				expect((yield* open(`${link.url}missing/`)).status).toBe(404)
				expect((yield* open(`${link.url}docs/a%20b.md/`)).status).toBe(404)
			}),
		))

	it("keeps the query string when it redirects to a folder", () =>
		withContent(({ api, open }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [
					{ path: "index.html", content: "home" },
					{ path: "docs/index.html", content: "docs" },
				])
				const link = yield* createLink(api, id)
				const root = new URL(link.url).pathname
				const bare = yield* open(`${link.url.slice(0, -1)}?tab=2&q=a%20b`)
				expect(bare.status).toBe(308)
				expect(bare.headers.get("location")).toBe(`${root}?tab=2&q=a%20b`)
				const folder = yield* open(`${link.url}docs?tab=2`)
				expect(folder.status).toBe(308)
				expect(folder.headers.get("location")).toBe(`${root}docs/?tab=2`)
				expect((yield* open(`${link.url}docs`)).headers.get("location")).toBe(`${root}docs/`)
			}),
		))

	it("answers HEAD from the manifest without reading the file", () =>
		withContent(({ api, open, store }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [
					{ path: "index.html", content: "<h1>home</h1>" },
					{ path: "dot.png", content: "iVBORw==", encoding: "base64" },
				])
				const link = yield* createLink(api, id)
				for (const path of ["", "dot.png"]) {
					const reads = store.blobReads()
					const head = yield* open(`${link.url}${path}`, "HEAD")
					expect(store.blobReads(), path).toBe(reads)
					const get = yield* open(`${link.url}${path}`)
					expect(store.blobReads(), path).toBe(reads + 1)
					expect(head.status, path).toBe(get.status)
					expect(Object.fromEntries(head.headers), path).toEqual(Object.fromEntries(get.headers))
					expect(yield* text(head), path).toBe("")
				}
				for (const key of store.objects.keys()) {
					if (key.includes("/blobs/")) {
						store.objects.delete(key)
					}
				}
				const reads = store.blobReads()
				const gone = yield* open(link.url, "HEAD")
				expect(gone.status).toBe(404)
				expect(store.blobReads()).toBe(reads)
			}),
		))

	it("answers a request for the version it already has with 304, before reading the file", () =>
		withContent(({ api, open, store }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [
					{ path: "index.html", content: "<h1>home</h1>" },
					{ path: "app.js", content: "run()" },
				])
				const link = yield* createLink(api, id)
				const home = yield* open(link.url)
				const etag = home.headers.get("etag") ?? ""
				expect(etag).toMatch(/^"[0-9a-f]{64}-[0-9a-f]{16}"$/)
				expect((yield* open(`${link.url}app.js`)).headers.get("etag")).not.toBe(etag)

				const untouched = () => [store.blobReads(), store.blobChecks()]
				for (const [method, ifNoneMatch] of [
					["GET", etag],
					["GET", `W/${etag}`],
					["GET", `"other", ${etag}`],
					["GET", "*"],
					["HEAD", etag],
				] as const) {
					const label = `${method} ${ifNoneMatch}`
					const before = untouched()
					const cached = yield* open(link.url, method, ifNoneMatch)
					expect(untouched(), label).toEqual(before)
					expect(cached.status, label).toBe(304)
					expect(cached.headers.get("etag"), label).toBe(etag)
					expect(cached.headers.get("cache-control"), label).toBe("private, no-cache")
					expectSandboxed(cached, label)
					expect(yield* text(cached), label).toBe("")
				}

				const reads = store.blobReads()
				const changed = yield* open(
					link.url,
					"GET",
					`"other", W/"${"0".repeat(64)}", "${etag.slice(1, 65)}"`,
				)
				expect(changed.status).toBe(200)
				expect(yield* text(changed)).toBe("<h1>home</h1>")
				expect(store.blobReads()).toBe(reads + 1)

				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				const gone = yield* open(link.url, "GET", etag)
				expect(gone.status).toBe(404)
				expect(gone.headers.get("etag")).toBeNull()
			}),
		))

	it("refuses a link made for another jurisdiction's storage", () =>
		withContent(({ api, open, openIn, sign }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "one" }])
				const link = yield* createLink(api, id)
				expect((yield* open(link.url)).status).toBe(200)
				expect((yield* openIn("eu", link.url)).status).toBe(404)

				const token = new URL(link.url).pathname.split("/")[2] ?? ""
				const claims = Base64Url.decodeString(token.split(".")[0] ?? "")
				const [, artifactId = "", version = "", expiresAt = ""] = (
					claims._tag === "Success" ? claims.success : ""
				).split(".")
				const signed = (scope: string) =>
					sign({ scope, artifactId, version: Number(version), expiresAt: Number(expiresAt) })
				const euLink = `${TEST_CONTENT_ORIGIN}/a/${yield* signed("eu")}/`
				expect((yield* openIn("eu", euLink)).status).toBe(200)
				expect((yield* open(euLink)).status).toBe(404)
				expect(
					(yield* open(`${TEST_CONTENT_ORIGIN}/a/${yield* signed(DEFAULT_STORAGE_SCOPE)}/`)).status,
				).toBe(200)
			}),
		))

	it("hands the handler the absolute URL the Worker received", () =>
		withContent(({ api, open }) =>
			Effect.gen(function* () {
				const request = webRequest("https://x.example/a/token/docs/a%20b.md?tab=2", "HEAD", '"tag"')
				expect(request).toEqual({
					method: "HEAD",
					url: "https://x.example/a/token/docs/a%20b.md?tab=2",
					ifNoneMatch: '"tag"',
				})
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "home" }])
				const link = yield* createLink(api, id)
				const elsewhere = link.url.replace(TEST_CONTENT_ORIGIN, "https://x.example")
				expect(yield* text(yield* open(elsewhere))).toBe("home")
			}),
		))

	it("changes the ETag when a version serves the same bytes as another type", () =>
		withContent(({ api, open }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [
					{ path: "data", content: "{}", content_type: "text/plain" },
				])
				const first = yield* createLink(api, id)
				const plainText = yield* open(`${first.url}data`)
				const etag = plainText.headers.get("etag") ?? ""
				expect(plainText.headers.get("content-type")).toBe("text/plain; charset=utf-8")
				const added = yield* api("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "data", content: "{}", content_type: "application/json" }],
				})
				expect(added.status).toBe(201)
				const second = yield* json<LinkBody>(
					yield* api("POST", `/v1/artifacts/${id}/versions/2/links`, {}),
				)
				const asJson = yield* open(`${second.url}data`, "GET", etag)
				expect(asJson.status).toBe(200)
				expect(asJson.headers.get("content-type")).toBe("application/json; charset=utf-8")
				expect(asJson.headers.get("etag")).not.toBe(etag)
				expect((yield* open(`${first.url}data`, "GET", etag)).status).toBe(304)
			}),
		))

	it("serves the head without the view, and waits for an older row, answering 503 while it is missing", () =>
		withContent(({ api, open, openLagging, sign }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "first" }])
				const first = yield* createLink(api, id)
				const added = yield* api("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "index.html", content: "second" }],
				})
				expect(added.status).toBe(201)
				expect(yield* text(yield* openLagging("caught-up", first.url))).toBe("first")
				expect(yield* text(yield* openLagging("catches-up", first.url))).toBe("first")
				const missing = yield* openLagging("never", first.url)
				expect(missing.status).toBe(503)
				expect(missing.headers.get("retry-after")).toBe("1")
				expectSandboxed(missing, "missing row")
				const head = yield* json<LinkBody>(
					yield* api("POST", `/v1/artifacts/${id}/versions/2/links`, {}),
				)
				expect(yield* text(yield* openLagging("never", head.url))).toBe("second")

				const ahead = yield* sign({
					scope: DEFAULT_STORAGE_SCOPE,
					artifactId: id,
					version: 3,
					expiresAt: Math.floor((yield* Clock.currentTimeMillis) / 1000) + 60,
				})
				expect((yield* openLagging("never", `${TEST_CONTENT_ORIGIN}/a/${ahead}/`)).status).toBe(404)
				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect((yield* openLagging("never", first.url)).status).toBe(404)
				expect((yield* open(first.url)).status).toBe(404)
			}),
		))

	it("keeps a link on the version it was made for", () =>
		withContent(({ api, open }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "first" }])
				const first = yield* createLink(api, id)
				const added = yield* api("POST", `/v1/artifacts/${id}/versions`, {
					version: 1,
					files: [{ path: "index.html", content: "second" }],
				})
				expect(added.status).toBe(201)
				const again = yield* createLink(api, id)
				const second = yield* json<LinkBody>(
					yield* api("POST", `/v1/artifacts/${id}/versions/2/links`, {}),
				)
				expect(second.version).toBe(2)
				expect(yield* text(yield* open(first.url))).toBe("first")
				expect(yield* text(yield* open(again.url))).toBe("first")
				expect(yield* text(yield* open(second.url))).toBe("second")
			}),
		))

	it("defaults to an hour and refuses lifetimes outside one minute to seven days", () =>
		withContent(({ api }) =>
			Effect.gen(function* () {
				const { id } = yield* createArtifact(api, [{ path: "index.html", content: "one" }])
				const before = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const link = yield* createLink(api, id)
				const expires = Math.floor(Date.parse(link.expires_at) / 1000)
				expect(expires).toBeGreaterThanOrEqual(before + DEFAULT_LINK_TTL_SECONDS)
				expect(expires).toBeLessThanOrEqual(before + DEFAULT_LINK_TTL_SECONDS + 2)
				const status = (body: unknown, version = 1) =>
					Effect.map(
						api("POST", `/v1/artifacts/${id}/versions/${version}/links`, body),
						(response) => response.status,
					)
				expect(yield* status({ expires_in: 59 })).toBe(400)
				expect(yield* status({ expires_in: MAX_LINK_TTL_SECONDS + 1 })).toBe(400)
				expect(yield* status({ expires_in: 1.5 })).toBe(400)
				expect(yield* status({ expires_in: MAX_LINK_TTL_SECONDS })).toBe(201)
				expect(yield* status({}, 2)).toBe(404)
			}),
		))
})
