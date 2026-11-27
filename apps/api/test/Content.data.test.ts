import { DATA_OPERATIONS, accessAt, permits } from "@checkfu/domain/Artifact/ArtifactAccess"
import type { DataOperation } from "@checkfu/domain/Artifact/ArtifactAccess"
import { describe, expect, it } from "vitest"
import * as Clock from "effect/Clock"
import * as Digest from "effect/crypto/Digest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import { VisitorData } from "../src/ArtifactData/VisitorData.ts"
import { ArtifactVersionResolver } from "../src/Artifacts/ResolveArtifactVersion.ts"
import { PublicationResolver } from "../src/Artifacts/ResolvePublication.ts"
import { ArtifactStore } from "../src/Artifacts/ArtifactStore.ts"
import { linkKey } from "../src/Content/ArtifactLink.ts"
import { TEST_LINK_SECRET } from "../src/Content/ArtifactLinks.ts"
import { contentRequestOf, serveContent } from "../src/Content/ContentHandler.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { DEFAULT_STORAGE_SCOPE } from "../src/Placement.ts"
import {
	AUTH_HEADERS,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

const PUBLISH_DOMAIN = "publish.test"
const MacLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))

interface Sent {
	readonly method?: string
	readonly body?: unknown
	readonly raw?: string
	readonly headers?: Record<string, string>
}

interface DocumentBody {
	readonly id: string
	readonly type: string
	readonly artifact_id: string
	readonly collection: string
	readonly data: unknown
	readonly created_at: string
	readonly updated_at: string
}

interface ListBody {
	readonly data: ReadonlyArray<DocumentBody>
	readonly next_page: string | null
}

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const COLLECTIONS = { hidden: "none", shown: "read", inbox: "add", board: "write" } as const

const declaring = (collections: Record<string, string>, content = "page") => [
	{ path: "index.html", content },
	{ path: "sub/page.html", content: "deeper" },
	{
		path: "artifact.json",
		content: JSON.stringify({
			capabilities: {
				database: {
					collections: Object.fromEntries(
						Object.entries(collections).map(([name, visitors]) => [name, { visitors }]),
					),
				},
			},
		}),
	},
]

const withPages = <A>(
	run: (world: {
		readonly api: (
			method: string,
			path: string,
			body?: unknown,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly page: (url: string, sent?: Sent) => Effect.Effect<Response>
		readonly onDomain: (url: string, sent?: Sent) => Effect.Effect<Response>
		readonly artifact: (collections: Record<string, string>) => Effect.Effect<string>
		readonly link: (id: string, access: string, version?: number) => Effect.Effect<string>
		readonly publish: (id: string, body: unknown) => Effect.Effect<string>
		readonly setNow: (millis: number) => void
	}) => Effect.Effect<A>,
) => {
	const { layer, closeAll } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "unused", 1, 1),
	)
	return Effect.runPromise(
		Effect.gen(function* () {
			const { fetch: apiFetch } = yield* makeApiHandler
			let now: number | undefined
			const serving = {
				mac: yield* Mac.Mac,
				digest: yield* Digest.Digest,
				key: yield* Effect.orDie(linkKey(TEST_LINK_SECRET)),
				store: yield* ArtifactStore,
				resolveArtifactVersion: yield* ArtifactVersionResolver,
				resolvePublication: yield* PublicationResolver,
				artifactData: yield* VisitorData,
				scope: DEFAULT_STORAGE_SCOPE,
				nowMillis: Effect.map(Clock.currentTimeMillis, (millis) => now ?? millis),
			}
			const serve = serveContent(serving)
			const serveOnDomain = serveContent({ ...serving, publishDomain: PUBLISH_DOMAIN })
			const request = (url: string, sent: Sent = {}) => {
				const body = sent.raw ?? (sent.body === undefined ? undefined : JSON.stringify(sent.body))
				return contentRequestOf(
					HttpServerRequest.fromWeb(
						new Request(url, {
							method: sent.method ?? "GET",
							headers: {
								...(body === undefined ? {} : { "content-type": "application/json" }),
								...sent.headers,
							},
							...(body === undefined ? {} : { body }),
						}),
					),
				)
			}
			const api = (
				method: string,
				path: string,
				body?: unknown,
				headers?: Record<string, string>,
			) =>
				sendRequest(apiFetch, {
					method,
					path,
					headers: { ...AUTH_HEADERS, ...headers },
					...(body === undefined ? {} : { body }),
				})
			return yield* run({
				api,
				page: (url, sent) => Effect.map(serve(request(url, sent)), HttpServerResponse.toWeb),
				onDomain: (url, sent) =>
					Effect.map(serveOnDomain(request(url, sent)), HttpServerResponse.toWeb),
				artifact: (collections) =>
					Effect.map(
						Effect.flatMap(
							api("POST", "/v1/artifacts", { name: "Page", files: declaring(collections) }),
							(response) => json<{ id: string }>(response),
						),
						(body) => body.id,
					),
				link: (id, access, version = 1) =>
					Effect.map(
						Effect.flatMap(
							api("POST", `/v1/artifacts/${id}/versions/${version}/links`, { access }),
							(response) => json<{ url: string }>(response),
						),
						(body) => body.url,
					),
				publish: (id, body) =>
					Effect.map(
						Effect.flatMap(api("POST", `/v1/artifacts/${id}/publication`, body), (response) =>
							json<{ publication: { url: string } }>(response),
						),
						(artifact) => artifact.publication.url,
					),
				setNow: (millis) => {
					now = millis
				},
			})
		}).pipe(
			Effect.scoped,
			Effect.provide([layer, MacLive, Digest.layerWebCrypto]),
			Effect.ensuring(Effect.promise(closeAll)),
		),
	)
}

const attempt = (
	page: (url: string, sent?: Sent) => Effect.Effect<Response>,
	root: string,
	collection: string,
	operation: DataOperation,
	id = "seeded",
) => {
	const data = `${root}_/data/${collection}`
	switch (operation) {
		case "list": {
			return page(data)
		}
		case "get": {
			return page(`${data}/${id}`)
		}
		case "add": {
			return page(data, { method: "POST", body: { data: "added" } })
		}
		case "put": {
			return page(`${data}/${id}`, { method: "PUT", body: { data: "replaced" } })
		}
		case "delete": {
			return page(`${data}/${id}`, { method: "DELETE" })
		}
	}
}

describe("A page reaching its artifact's data", () => {
	it("is allowed exactly what its link's level and the collection's visitors setting allow", () =>
		withPages(({ api, page, artifact, link }) =>
			Effect.gen(function* () {
				for (const level of ["view", "read", "write"] as const) {
					const id = yield* artifact(COLLECTIONS)
					const root = yield* link(id, level)
					for (const [collection, visitors] of Object.entries(COLLECTIONS)) {
						for (const operation of DATA_OPERATIONS) {
							yield* api("PUT", `/v1/artifacts/${id}/data/${collection}/seeded`, { data: "seed" })
							const response = yield* attempt(page, root, collection, operation)
							const allowed = permits(accessAt(level, visitors), operation)
							expect([level, collection, operation, response.status]).toEqual([
								level,
								collection,
								operation,
								allowed ? (operation === "add" ? 201 : 200) : 403,
							])
							const held = yield* json<ListBody>(
								yield* api("GET", `/v1/artifacts/${id}/data/${collection}`),
							)
							const changed =
								held.data.length !== 1 || held.data[0]?.data !== "seed" ? operation : "nothing"
							expect([level, collection, operation, changed]).toEqual([
								level,
								collection,
								operation,
								allowed && operation !== "list" && operation !== "get" ? operation : "nothing",
							])
							for (const document of held.data) {
								yield* api("DELETE", `/v1/artifacts/${id}/data/${collection}/${document.id}`)
							}
						}
					}
					for (const operation of DATA_OPERATIONS) {
						expect((yield* attempt(page, root, "undeclared", operation)).status).toBe(403)
						expect((yield* attempt(page, root, "Not-A-Name", operation)).status).toBe(403)
					}
				}
			}),
		))

	it("adds, lists, reads, replaces and deletes documents through a write link, as JSON that is never cached", () =>
		withPages(({ api, page, artifact, link }) =>
			Effect.gen(function* () {
				const id = yield* artifact(COLLECTIONS)
				const root = yield* link(id, "write")
				const board = `${root}_/data/board`

				const added = yield* page(board, { method: "POST", body: { data: { text: "first" } } })
				expect(added.status).toBe(201)
				expect(added.headers.get("content-type")).toBe("application/json")
				expect(added.headers.get("cache-control")).toBe("private, no-store")
				expect(added.headers.get("access-control-allow-origin")).toBe("*")
				const first = yield* json<DocumentBody>(added)
				expect(first).toEqual({
					id: expect.stringMatching(/^doc_[0-9a-f]{24}$/),
					type: "artifact_document",
					artifact_id: id,
					collection: "board",
					data: { text: "first" },
					created_at: expect.any(String),
					updated_at: first.created_at,
				})
				expect(
					yield* json(yield* api("GET", `/v1/artifacts/${id}/data/board/${first.id}`)),
				).toEqual(first)

				yield* page(`${board}/pinned`, { method: "PUT", body: { data: [1, 2] } })
				yield* page(board, { method: "POST", body: { data: null } })
				const firstPage = yield* json<ListBody>(yield* page(`${board}?limit=2`))
				expect(firstPage.data.map((document) => document.data)).toEqual([{ text: "first" }, [1, 2]])
				const rest = yield* json<ListBody>(
					yield* page(`${board}?limit=2&page=${firstPage.next_page}`),
				)
				expect(rest.data.map((document) => document.data)).toEqual([null])
				expect(rest.next_page).toBeNull()

				expect(yield* json(yield* page(`${board}/pinned`))).toMatchObject({
					id: "pinned",
					data: [1, 2],
				})
				expect(
					yield* json(yield* page(`${board}/pinned`, { method: "PUT", body: { data: "again" } })),
				).toMatchObject({ id: "pinned", data: "again" })
				const deleted = yield* page(`${board}/pinned`, { method: "DELETE" })
				expect(yield* json(deleted)).toEqual({ id: "pinned", type: "artifact_document_deleted" })
				expect((yield* page(`${board}/pinned`)).status).toBe(404)
				expect((yield* page(`${board}/pinned`, { method: "DELETE" })).status).toBe(404)

				const key = { "idempotency-key": "submit-1" }
				const once = yield* json<DocumentBody>(
					yield* page(board, { method: "POST", body: { data: "form" }, headers: key }),
				)
				const again = yield* page(board, { method: "POST", body: { data: "form" }, headers: key })
				expect(again.status).toBe(201)
				expect(yield* json(again)).toEqual(once)
				const reused = yield* page(board, {
					method: "POST",
					body: { data: "other" },
					headers: key,
				})
				expect(reused.status).toBe(409)
				expect(yield* json(reused)).toMatchObject({
					error: { code: "idempotency_key_reused" },
				})

				const owned = yield* json<DocumentBody>(
					yield* api("POST", `/v1/artifacts/${id}/data/board`, { data: "the owner's" }, key),
				)
				expect(owned.id).not.toBe(once.id)
				expect(owned.data).toBe("the owner's")
			}),
		))

	it("refuses what it cannot read or hold, and answers preflight without granting anything", () =>
		withPages(({ page, artifact, link }) =>
			Effect.gen(function* () {
				const id = yield* artifact(COLLECTIONS)
				const root = yield* link(id, "write")
				const board = `${root}_/data/board`
				const status = (url: string, sent?: Sent) =>
					Effect.map(page(url, sent), (response) => response.status)

				expect(yield* status(board, { method: "POST", raw: "{" })).toBe(400)
				expect(yield* status(board, { method: "POST", body: {} })).toBe(400)
				expect(yield* status(board, { method: "POST", body: { data: 1, extra: 2 } })).toBe(400)
				expect(yield* status(`${board}/a`, { method: "PUT", raw: "" })).toBe(400)
				expect(yield* status(board, { method: "POST", body: { data: "x".repeat(65_536) } })).toBe(
					400,
				)
				expect(yield* status(board, { method: "POST", body: { data: "x".repeat(140_000) } })).toBe(
					413,
				)
				expect(yield* status(`${board}?limit=0`)).toBe(400)
				expect(yield* status(`${board}?limit=101`)).toBe(400)
				expect(yield* status(`${board}?page=abc`)).toBe(400)
				expect(yield* status(`${board}?page=-5`)).toBe(400)
				expect(yield* status(`${board}/`, { method: "POST", body: { data: 1 } })).toBe(405)
				expect(yield* status(`${root}_%2Fdata%2Fboard`)).toBe(200)
				expect(yield* status(`${root}%5F/data/board`)).toBe(200)
				expect(yield* status(`${root}_/data/../data/board`)).toBe(200)
				expect(yield* status(`${root}_/data/board`, { method: "HEAD" })).toBe(405)
				expect(yield* status(`${board}/has.dot`)).toBe(404)
				expect(yield* status(`${board}/a/b`)).toBe(404)
				expect(yield* status(`${root}_/data`)).toBe(404)
				expect(yield* status(`${root}_/data/`)).toBe(404)
				expect(yield* status(`${root}_/other/board`)).toBe(404)
				expect(yield* status(`${root}_/`)).toBe(404)
				expect(yield* status(`${root}sub/_/data/board`)).toBe(404)
				expect(yield* status(board, { method: "PATCH" })).toBe(405)
				expect(yield* status(board, { method: "DELETE" })).toBe(405)
				expect(yield* status(`${board}/a`, { method: "POST", body: { data: 1 } })).toBe(405)

				const collection = yield* page(board, { method: "OPTIONS" })
				expect(collection.status).toBe(204)
				expect(collection.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS")
				expect(collection.headers.get("access-control-allow-headers")).toBe(
					"content-type, idempotency-key",
				)
				expect(collection.headers.get("access-control-allow-origin")).toBe("*")
				const document = yield* page(`${board}/a`, { method: "OPTIONS" })
				expect(document.headers.get("access-control-allow-methods")).toBe(
					"GET, PUT, DELETE, OPTIONS",
				)
				const stranger = yield* page("http://content.test/a/not-a-link/_/data/board", {
					method: "OPTIONS",
				})
				expect(stranger.status).toBe(204)
				expect(yield* status("http://content.test/a/not-a-link/_/data/board")).toBe(404)
				expect((yield* page(`${root}index.html`, { method: "OPTIONS" })).status).toBe(204)
				expect(yield* status(`${root}index.html`)).toBe(200)
			}),
		))

	it("stops answering when the link is forged or expires, or the artifact is deleted", () =>
		withPages(({ api, page, artifact, link, setNow }) =>
			Effect.gen(function* () {
				const id = yield* artifact(COLLECTIONS)
				const read = yield* link(id, "read")
				const write = yield* link(id, "write")
				const status = (url: string, sent?: Sent) =>
					Effect.map(page(url, sent), (response) => response.status)
				expect(yield* status(`${read}_/data/shown`)).toBe(200)

				const [claims = "", tag = ""] = (new URL(read).pathname.split("/")[2] ?? "").split(".")
				const widened = Buffer.from(
					Buffer.from(claims, "base64url").toString().replace(/read$/, "write"),
				).toString("base64url")
				expect(widened).not.toBe(claims)
				expect(
					yield* status(`http://content.test/a/${widened}.${tag}/_/data/board`, {
						method: "POST",
						body: { data: 1 },
					}),
				).toBe(404)

				const now = yield* Clock.currentTimeMillis
				setNow(now + 2 * 60 * 60 * 1000)
				expect(yield* status(`${read}_/data/shown`)).toBe(404)
				setNow(now)

				expect((yield* api("DELETE", `/v1/artifacts/${id}`)).status).toBe(200)
				expect(yield* status(`${read}_/data/shown`)).toBe(404)
				expect(yield* status(`${write}_/data/board`, { method: "POST", body: { data: 1 } })).toBe(
					404,
				)
			}),
		))

	it("keeps a link to an older version working by that version's declaration", () =>
		withPages(({ api, page, artifact, link }) =>
			Effect.gen(function* () {
				const id = yield* artifact({ board: "write" })
				expect(
					(yield* api("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: declaring({ board: "read", extra: "write" }, "second"),
					})).status,
				).toBe(201)
				const older = yield* link(id, "write", 1)
				const newer = yield* link(id, "write", 2)
				const add = (root: string, collection: string) =>
					Effect.map(
						page(`${root}_/data/${collection}`, { method: "POST", body: { data: 1 } }),
						(response) => response.status,
					)
				expect(yield* add(older, "board")).toBe(201)
				expect(yield* add(older, "extra")).toBe(403)
				expect(yield* add(newer, "board")).toBe(403)
				expect(yield* add(newer, "extra")).toBe(201)
				expect(
					(yield* json<ListBody>(yield* page(`${newer}_/data/board`))).data.map(
						(document) => document.data,
					),
				).toEqual([1])
			}),
		))

	it("gives a public address what the owner granted and the version served still declares, and no more", () =>
		withPages(({ api, page, onDomain, artifact, publish }) =>
			Effect.gen(function* () {
				const id = yield* artifact({ inbox: "add", board: "read" })
				const add = (root: string, collection: string, send = page) =>
					Effect.map(
						send(`${root}_/data/${collection}`, { method: "POST", body: { data: 1 } }),
						(response) => response.status,
					)
				const list = (root: string, collection: string) =>
					Effect.map(page(`${root}_/data/${collection}`), (response) => response.status)

				const root = yield* publish(id, {})
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([403, 403])
				yield* publish(id, { access: "read" })
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([403, 200])
				yield* publish(id, { access: "write" })
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([201, 200])
				expect(yield* list(root, "inbox")).toBe(403)

				const address = new URL(root).pathname.split("/")[2] ?? ""
				expect(yield* add(`https://${address}.${PUBLISH_DOMAIN}/`, "inbox", onDomain)).toBe(201)
				expect(yield* add("http://content.test/p/a0-0000000000000000000000000/", "inbox")).toBe(404)
				const wrongToken = `${address.slice(0, -1)}${address.endsWith("0") ? "1" : "0"}`
				expect(wrongToken).not.toBe(address)
				expect(yield* add(`http://content.test/p/${wrongToken}/`, "inbox")).toBe(404)
				expect(yield* list(`http://content.test/p/${wrongToken}/`, "board")).toBe(404)

				expect(
					(yield* api("POST", `/v1/artifacts/${id}/versions`, {
						version: 1,
						files: declaring({ inbox: "write", board: "write", extra: "write" }, "second"),
					})).status,
				).toBe(201)
				expect([
					yield* list(root, "inbox"),
					yield* add(root, "board"),
					yield* add(root, "extra"),
					yield* add(root, "inbox"),
				]).toEqual([403, 403, 403, 201])
				yield* publish(id, { access: "write" })
				expect([
					yield* list(root, "inbox"),
					yield* add(root, "board"),
					yield* add(root, "extra"),
				]).toEqual([200, 201, 201])

				expect(
					(yield* api("POST", `/v1/artifacts/${id}/versions`, {
						version: 2,
						files: [{ path: "index.html", content: "third" }],
					})).status,
				).toBe(201)
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([403, 403])
				expect(
					(yield* json<{ collections: ReadonlyArray<{ name: string }> }>(
						yield* api("GET", `/v1/artifacts/${id}/data`),
					)).collections.map((collection) => collection.name),
				).toEqual(["board", "extra", "inbox"])
				yield* publish(id, { version: 2 })
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([201, 200])

				expect((yield* api("DELETE", `/v1/artifacts/${id}/publication`)).status).toBe(200)
				expect([yield* add(root, "inbox"), yield* list(root, "board")]).toEqual([404, 404])
			}),
		))
})
