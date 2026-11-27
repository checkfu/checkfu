import { createHash } from "node:crypto"
import { MAX_FILE_BYTES } from "@checkfu/sdk/Limits"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { describe, expect, it } from "vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Stream from "effect/Stream"
import type { ByteRange } from "../src/Content/ByteRange.ts"
import { FileStore, FileStoreError } from "../src/Files/FileStore.ts"
import { makeApiHandler } from "../src/Http/Router.ts"
import { DEFAULT_STORAGE_SCOPE as SCOPE } from "../src/Placement.ts"
import {
	AUTH_HEADERS,
	TEST_RUNTIME,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
} from "./helpers/ApiHarness.ts"

type World = ReturnType<typeof makePiDurableTestLayer>

interface FileBody {
	readonly id: string
	readonly type: string
	readonly filename: string
	readonly content_type: string
	readonly size: number
	readonly sha256: string
	readonly origin: { readonly type: string }
	readonly created_at: string
}

interface ErrorBody {
	readonly error: { readonly type: string; readonly message: string }
}

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

const bytesOf = (length: number, seed = 11) =>
	Uint8Array.from({ length }, (_, index) => (index * 37 + seed) % 256)

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const contentKey = (id: string) => `files/${SCOPE}/${id}/content`

const withFiles = <A>(
	run: (world: {
		readonly store: World["fileStore"]
		readonly call: (
			method: string,
			path: string,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
		readonly transfers: ReadonlyArray<{ readonly range: ByteRange | undefined; size: number }>
		readonly upload: (
			query: string,
			body: Uint8Array | ReadableStream<Uint8Array>,
			headers?: Record<string, string>,
		) => Effect.Effect<Response>
	}) => Effect.Effect<A>,
) => {
	const { layer, closeAll, fileStore } = makePiDurableTestLayer(async (model) =>
		makeAssistantReply(model, null, "ok", 1, 1),
	)
	return Effect.runPromise(
		Effect.gen(function* () {
			const storage = yield* FileStore
			const transfers: Array<{ readonly range: ByteRange | undefined; size: number }> = []
			const { fetch: apiFetch } = yield* makeApiHandler.pipe(
				Effect.provideService(FileStore, {
					...storage,
					content: (id, range) =>
						Effect.gen(function* () {
							const transfer = { range, size: 0 }
							transfers.push(transfer)
							const body = yield* storage.content(id, range)
							return (
								body?.pipe(
									Stream.tap((chunk) =>
										Effect.sync(() => {
											transfer.size += chunk.byteLength
										}),
									),
								) ?? null
							)
						}),
				}),
			)
			return yield* run({
				store: fileStore,
				transfers,
				call: (method, path, headers) =>
					sendRequest(apiFetch, { method, path, headers: { ...AUTH_HEADERS, ...headers } }),
				upload: (query, body, headers) => {
					const requestHeaders = new Headers({
						...AUTH_HEADERS,
						"content-type": "application/octet-stream",
						...headers,
					})
					const isBytes = ArrayBuffer.isView(body)
					if (isBytes && !requestHeaders.has("content-length")) {
						requestHeaders.set("content-length", String(body.byteLength))
					}
					const options = {
						method: "POST",
						headers: requestHeaders,
						body: isBytes ? new Blob([new Uint8Array(body)]) : body,
						duplex: "half",
					}
					return Effect.map(
						apiFetch.pipe(
							Effect.provideService(
								HttpServerRequest.HttpServerRequest,
								HttpServerRequest.fromWeb(
									new Request(`http://localhost/v1/files?${query}`, options),
								),
							),
							Effect.provideService(RuntimeContext, TEST_RUNTIME),
						),
						HttpServerResponse.toWeb,
					)
				},
			})
		}).pipe(Effect.scoped, Effect.provide(layer), Effect.ensuring(Effect.promise(closeAll))),
	)
}

describe("Files API", () => {
	it("passes a single file range to storage and checks request conditions first", () =>
		withFiles(({ upload, call, transfers }) =>
			Effect.gen(function* () {
				const block = 64 * 1024
				const data = bytesOf(4 * block)
				const file = yield* json<FileBody>(yield* upload("filename=report.bin", data))
				const path = `/v1/files/${file.id}/content`
				const etag = `"${file.sha256}"`
				const downloaded = yield* call("GET", path)
				expect(new Uint8Array(yield* Effect.promise(() => downloaded.arrayBuffer()))).toEqual(data)
				expect(downloaded.headers.get("accept-ranges")).toBe("bytes")
				for (const [header, offset, length] of [
					[`bytes=0-${block - 1}`, 0, block],
					[`bytes=-${block}`, data.length - block, block],
					[`bytes=${block * 2}-`, block * 2, block * 2],
				] as const) {
					const response = yield* call("GET", path, { range: header, "if-range": etag })
					expect(response.status, header).toBe(206)
					expect(response.headers.get("content-range")).toBe(
						`bytes ${offset}-${offset + length - 1}/${data.length}`,
					)
					expect(response.headers.get("content-length")).toBe(String(length))
					expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
						data.subarray(offset, offset + length),
					)
				}
				expect(transfers).toEqual([
					{ range: undefined, size: data.length },
					{ range: { offset: 0, length: block }, size: block },
					{ range: { offset: data.length - block, length: block }, size: block },
					{ range: { offset: block * 2, length: block * 2 }, size: block * 2 },
				])
				const atEnd = { range: `bytes=${data.length}-` }
				const cached = yield* call("GET", path, { ...atEnd, "if-none-match": `W/${etag}` })
				expect(cached.status).toBe(304)
				const unsatisfied = yield* call("GET", path, atEnd)
				expect(unsatisfied.status).toBe(416)
				expect(unsatisfied.headers.get("content-range")).toBe(`bytes */${data.length}`)
				expect(transfers).toHaveLength(4)
				const head = yield* call("HEAD", path, atEnd)
				expect(head.status).toBe(200)
				expect(head.headers.get("content-range")).toBeNull()
				expect(head.headers.get("content-length")).toBe(String(data.length))
				expect((yield* Effect.promise(() => head.arrayBuffer())).byteLength).toBe(0)
				expect(transfers).toHaveLength(4)
				for (const headers of [
					{ range: "bytes=3-1" },
					{ range: "bytes=9007199254740993-9007199254740992" },
					{ range: "bytes=0-1,6-9" },
					{ range: "items=0-1" },
					{ range: "bytes=0-1", "if-range": `W/${etag}` },
				]) {
					const full = yield* call("GET", path, headers)
					expect(full.status).toBe(200)
					expect((yield* Effect.promise(() => full.arrayBuffer())).byteLength).toBe(data.length)
				}
				const empty = yield* json<FileBody>(yield* upload("filename=empty.bin", new Uint8Array()))
				expect(
					(yield* call("GET", `/v1/files/${empty.id}/content`, { range: "bytes=-1" })).status,
				).toBe(416)
				yield* call("DELETE", `/v1/files/${file.id}`)
				expect((yield* call("GET", path, { range: "bytes=0-1" })).status).toBe(404)
			}),
		))

	it("uploads a file, then retrieves, lists, downloads and deletes it", () =>
		withFiles(({ call, upload, store }) =>
			Effect.gen(function* () {
				const data = bytesOf(70_000)
				const uploaded = yield* upload("filename=report.pdf", data)
				expect(uploaded.status).toBe(201)
				const file = yield* json<FileBody>(uploaded)
				expect(file).toEqual({
					id: expect.stringMatching(/^file_[0-9a-f]{24}$/),
					type: "file",
					filename: "report.pdf",
					content_type: "application/pdf",
					size: 70_000,
					sha256: sha256(data),
					origin: { type: "upload" },
					created_at: expect.any(String),
				})
				expect(yield* json(yield* call("GET", `/v1/files/${file.id}`))).toEqual(file)
				expect(
					(yield* json<{ data: ReadonlyArray<FileBody> }>(yield* call("GET", "/v1/files"))).data,
				).toEqual([file])

				const download = yield* call("GET", `/v1/files/${file.id}/content`)
				expect(download.status).toBe(200)
				expect(download.headers.get("content-type")).toBe("application/pdf")
				expect(download.headers.get("content-length")).toBe("70000")
				expect(download.headers.get("content-disposition")).toBe(
					"attachment; filename*=UTF-8''report.pdf",
				)
				expect(new Uint8Array(yield* Effect.promise(() => download.arrayBuffer()))).toEqual(data)

				const deleted = yield* call("DELETE", `/v1/files/${file.id}`)
				expect(yield* json(deleted)).toEqual({ id: file.id, type: "file_deleted" })
				expect(store.objects.size).toBe(0)
				expect((yield* call("GET", `/v1/files/${file.id}`)).status).toBe(404)
				expect((yield* call("GET", `/v1/files/${file.id}/content`)).status).toBe(404)
				expect((yield* call("DELETE", `/v1/files/${file.id}`)).status).toBe(200)
				expect(
					(yield* json<{ data: ReadonlyArray<FileBody> }>(yield* call("GET", "/v1/files"))).data,
				).toEqual([])
				expect((yield* call("GET", "/v1/files/file_missing")).status).toBe(404)
			}),
		))

	it("takes the content type from the query, then the filename, then a default", () =>
		withFiles(({ upload }) =>
			Effect.gen(function* () {
				const typeOf = (query: string) =>
					Effect.map(
						Effect.flatMap(upload(query, bytesOf(4)), json<FileBody>),
						(file) => file.content_type,
					)
				expect(yield* typeOf("filename=notes.md")).toBe("text/markdown")
				expect(yield* typeOf("filename=notes.md&content_type=text%2Fplain")).toBe("text/plain")
				expect(yield* typeOf("filename=data")).toBe("application/octet-stream")
			}),
		))

	it("names the download after the file, however the name is spelled", () =>
		withFiles(({ call, upload }) =>
			Effect.gen(function* () {
				const file = yield* json<FileBody>(
					yield* upload(`filename=${encodeURIComponent("résumé (final)'s.pdf")}`, bytesOf(4)),
				)
				expect(file.filename).toBe("résumé (final)'s.pdf")
				const download = yield* call("GET", `/v1/files/${file.id}/content`)
				expect(download.headers.get("content-disposition")).toBe(
					"attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29%27s.pdf",
				)
			}),
		))

	it("stores an empty file", () =>
		withFiles(({ call, upload }) =>
			Effect.gen(function* () {
				const empty = new Uint8Array(0)
				const file = yield* json<FileBody>(yield* upload("filename=empty.txt", empty))
				expect(file).toMatchObject({ size: 0, sha256: sha256(empty) })
				const download = yield* call("GET", `/v1/files/${file.id}/content`)
				expect((yield* Effect.promise(() => download.arrayBuffer())).byteLength).toBe(0)
			}),
		))

	it("stops reading when a streamed upload exceeds its declared length", () =>
		withFiles(({ upload, store }) =>
			Effect.gen(function* () {
				let pulled = 0
				let cancelled = false
				const body = new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							pulled += 1
							if (pulled > 1) {
								controller.error(new Error("Unexpected additional read"))
								return
							}
							controller.enqueue(bytesOf(1))
						},
						cancel() {
							cancelled = true
						},
					},
					{ highWaterMark: 0 },
				)
				const response = yield* upload("filename=empty.txt", body, { "content-length": "0" })
				expect(response.status).toBe(400)
				expect(pulled).toBe(1)
				expect(cancelled).toBe(true)
				expect(store.writes()).toBe(0)
			}),
		))

	it("refuses a missing or unsafe filename, a missing length, and a body over the limit", () =>
		withFiles(({ upload, store }) =>
			Effect.gen(function* () {
				const status = (query: string, headers?: Record<string, string>) =>
					Effect.map(upload(query, bytesOf(8), headers), (response) => response.status)
				expect(yield* status("")).toBe(400)
				expect(yield* status("filename=a%2Fb.txt")).toBe(400)
				expect(yield* status("filename=..")).toBe(400)
				expect(yield* status("filename=a.txt&content_type=nonsense")).toBe(400)
				expect(yield* status("filename=a.txt", { "content-length": "eight" })).toBe(400)
				const missingLength = yield* upload(
					"filename=a.txt",
					new ReadableStream({
						start(controller) {
							controller.close()
						},
					}),
				)
				expect(missingLength.status).toBe(400)
				expect((yield* json<ErrorBody>(missingLength)).error.message).toContain("Content-Length")
				expect(store.writes()).toBe(0)

				const tooLarge = yield* upload("filename=a.txt", bytesOf(8), {
					"content-length": String(MAX_FILE_BYTES + 1),
				})
				expect(tooLarge.status).toBe(413)
				expect((yield* json<ErrorBody>(tooLarge)).error.message).toContain("at most")

				const short = yield* upload("filename=a.txt", bytesOf(8), { "content-length": "9" })
				expect(short.status).toBe(400)
				expect((yield* json<ErrorBody>(short)).error.message).toContain("8 bytes, not the 9")
				const nonempty = yield* upload("filename=a.txt", bytesOf(8), { "content-length": "0" })
				expect(nonempty.status).toBe(400)
				expect(store.objects.size).toBe(0)
			}),
		))

	it("answers a retried upload with the same file, and refuses the key for other bytes", () =>
		withFiles(({ call, upload, store }) =>
			Effect.gen(function* () {
				const data = bytesOf(5000)
				const key = { "idempotency-key": "upload-report" }
				const first = yield* json<FileBody>(yield* upload("filename=report.pdf", data, key))
				const again = yield* upload("filename=report.pdf", data, key)
				expect(again.status).toBe(201)
				expect(yield* json(again)).toEqual(first)
				expect(store.writes()).toBe(1)
				expect(store.objects.has(contentKey(first.id))).toBe(true)

				const mismatched = yield* upload("filename=report.pdf", data, {
					...key,
					"content-length": "4999",
				})
				expect(mismatched.status).toBe(400)
				expect((yield* json<ErrorBody>(mismatched)).error.message).toContain(
					"5000 bytes, not the 4999",
				)
				expect((yield* upload("filename=report.pdf", bytesOf(5000, 7), key)).status).toBe(409)
				expect((yield* upload("filename=other.pdf", data, key)).status).toBe(409)
				expect(store.writes()).toBe(1)

				yield* call("DELETE", `/v1/files/${first.id}`)
				expect((yield* upload("filename=report.pdf", data, key)).status).toBe(409)
				expect(store.objects.size).toBe(0)
			}),
		))

	it("keeps the bytes of the upload that created the file when two share a key", () =>
		withFiles(({ call, upload, store }) =>
			Effect.gen(function* () {
				const key = { "idempotency-key": "contended" }
				const slow = bytesOf(4000, 1)
				const quick = bytesOf(4000, 2)
				const storing = yield* Deferred.make<void>()
				const proceed = yield* Deferred.make<void>()
				store.setBeforeStore(
					Effect.andThen(Deferred.succeed(storing, undefined), Deferred.await(proceed)),
				)
				const first = yield* Effect.forkChild(upload("filename=a.bin", slow, key))
				yield* Deferred.await(storing)
				const second = yield* Effect.forkChild(upload("filename=a.bin", quick, key))
				yield* Effect.sleep("50 millis")
				yield* Deferred.succeed(proceed, undefined)
				const lost = yield* Fiber.join(first)
				const won = yield* Fiber.join(second)
				expect(lost.status).toBe(503)
				expect(won.status).toBe(201)
				const file = yield* json<FileBody>(won)
				expect(file.sha256).toBe(sha256(quick))
				const download = yield* call("GET", `/v1/files/${file.id}/content`)
				expect(new Uint8Array(yield* Effect.promise(() => download.arrayBuffer()))).toEqual(quick)
				expect((yield* upload("filename=a.bin", slow, key)).status).toBe(409)
				expect((yield* upload("filename=a.bin", quick, key)).status).toBe(201)
			}),
		))

	it("answers an upload that finished after its retry created the file with that file", () =>
		withFiles(({ upload, store }) =>
			Effect.gen(function* () {
				const key = { "idempotency-key": "overtaken" }
				const data = bytesOf(4000, 3)
				const stored = yield* Deferred.make<void>()
				const proceed = yield* Deferred.make<void>()
				store.setAfterPut(
					Effect.andThen(Deferred.succeed(stored, undefined), Deferred.await(proceed)),
				)
				const first = yield* Effect.forkChild(upload("filename=a.bin", data, key))
				yield* Deferred.await(stored)
				store.setAfterPut(Effect.void)
				const retry = yield* upload("filename=a.bin", data, key)
				expect(retry.status).toBe(201)
				yield* Deferred.succeed(proceed, undefined)
				const overtaken = yield* Fiber.join(first)
				expect(overtaken.status).toBe(201)
				expect(yield* json(overtaken)).toEqual(yield* json(retry))
			}),
		))

	it("refuses an upload that finished after other bytes took its key", () =>
		withFiles(({ call, upload, store }) =>
			Effect.gen(function* () {
				const key = { "idempotency-key": "taken" }
				const mine = bytesOf(4000, 5)
				const theirs = bytesOf(4000, 6)
				const stored = yield* Deferred.make<void>()
				const proceed = yield* Deferred.make<void>()
				store.setAfterPut(
					Effect.andThen(Deferred.succeed(stored, undefined), Deferred.await(proceed)),
				)
				const first = yield* Effect.forkChild(upload("filename=a.bin", mine, key))
				yield* Deferred.await(stored)
				store.setAfterPut(Effect.void)
				const other = yield* upload("filename=a.bin", theirs, key)
				expect(other.status).toBe(201)
				const file = yield* json<FileBody>(other)
				yield* Deferred.succeed(proceed, undefined)
				expect((yield* Fiber.join(first)).status).toBe(409)
				const download = yield* call("GET", `/v1/files/${file.id}/content`)
				expect(new Uint8Array(yield* Effect.promise(() => download.arrayBuffer()))).toEqual(theirs)
			}),
		))

	it("answers 503 and keeps nothing when storage fails, and stores the file on a retry", () =>
		withFiles(({ call, upload, store }) =>
			Effect.gen(function* () {
				const data = bytesOf(100)
				const key = { "idempotency-key": "flaky" }
				store.setFailing(true)
				expect((yield* upload("filename=a.bin", data, key)).status).toBe(503)
				expect(store.objects.size).toBe(0)
				expect(
					(yield* json<{ data: ReadonlyArray<FileBody> }>(yield* call("GET", "/v1/files"))).data,
				).toEqual([])
				store.setFailing(false)
				store.setBeforeStore(Effect.fail(new FileStoreError({ cause: "write failed" })))
				expect((yield* upload("filename=a.bin", data, key)).status).toBe(503)
				expect(store.objects.size).toBe(0)
				store.setBeforeStore(Effect.void)
				const retried = yield* upload("filename=a.bin", data, key)
				expect(retried.status).toBe(201)
				expect((yield* json<FileBody>(retried)).sha256).toBe(sha256(data))
			}),
		))
})
