import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Checkfu } from "../src/Checkfu.ts"
import { CheckfuClient } from "../src/Client.ts"
import { MAX_ARTIFACT_FILE_BYTES } from "../src/Limits.ts"

const artifact = "art_download"
const file = "docs/résumé + 1.bin"
const version = 2
const bytes = Uint8Array.of(0, 127, 255, 128)
const config = { apiKey: "ck_test_key", baseUrl: "http://localhost:1337" }

describe("version-pinned artifact bytes", () => {
	it("fetches the selected version and preserves binary bytes and metadata in both facades", async () => {
		let calls = 0
		const fetch: typeof globalThis.fetch = async (input, init) => {
			calls += 1
			const request = new Request(input, init)
			const url = new URL(request.url)
			expect(url.pathname).toBe("/v1/artifacts/" + artifact + "/versions/2/content")
			expect(url.searchParams.get("file")).toBe(file)
			expect(request.headers.get("authorization")).toBe("Bearer ck_test_key")
			return new Response(bytes, {
				status: 200,
				headers: { "content-type": "application/x-report", "request-id": "req_artifact" },
			})
		}
		const client = new Checkfu({ ...config, fetch })
		try {
			const call = client.artifacts.versions.content(artifact, version, { file })
			expect(await call).toEqual(bytes)
			const response = await call.asResponse()
			expect(response.headers.get("content-type")).toBe("application/x-report")
			expect(response.headers.get("request-id")).toBe("req_artifact")
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
			expect(calls).toBe(1)
			expect(typeof client.artifacts.versions.file).toBe("function")
			expect(typeof client.artifacts.versions.link).toBe("function")
		} finally {
			await client.close()
		}

		const checked = await Effect.runPromise(
			Effect.gen(function* () {
				const sdk = yield* CheckfuClient
				return yield* sdk.artifacts.versions.content(
					artifact,
					version,
					{ file },
					{ withResponse: true },
				)
			}).pipe(Effect.provide(CheckfuClient.layerFetch({ ...config, fetch }))),
		)
		expect(checked.data).toEqual(bytes)
		expect(checked.status).toBe(200)
		expect(checked.requestId).toBe("req_artifact")
		expect(calls).toBe(2)
	})

	it("rejects invalid selectors and keys locally and keeps ordinary owner errors", async () => {
		let calls = 0
		const client = new Checkfu({
			...config,
			fetch: async () => {
				calls += 1
				return Response.json(
					{ type: "error", error: { type: "not_found_error", message: "Not found." } },
					{ status: 404 },
				)
			},
		})
		try {
			const content = client.artifacts.versions.content.bind(client.artifacts.versions)
			await expect(content(artifact, 0, { file })).rejects.toMatchObject({ status: 400 })
			await expect(content(artifact, version, { file: "../secrets" })).rejects.toMatchObject({
				status: 400,
			})
			await expect(
				content(artifact, version, { file }, { headers: { "Idempotency-Key": "key" } }),
			).rejects.toMatchObject({
				_tag: "CheckfuConfigError",
			})
			expect(calls).toBe(0)
			await expect(content(artifact, version, { file })).rejects.toMatchObject({ status: 404 })
			expect(calls).toBe(1)
		} finally {
			await client.close()
		}
	})

	it("settles an abort when the underlying fetch body has not finished cancellation", async () => {
		const reading = Promise.withResolvers<void>()
		const stopped = new AbortController()
		let cancelled = 0
		const stream = new ReadableStream<Uint8Array>({
			pull: () => {
				reading.resolve()
				return new Promise<void>(() => {})
			},
			cancel: () => {
				cancelled += 1
				return new Promise<void>(() => {})
			},
		})
		const client = new Checkfu({ ...config, fetch: async () => new Response(stream) })
		try {
			const call = client.artifacts.versions.content(
				artifact,
				version,
				{ file },
				{ signal: stopped.signal },
			)
			await reading.promise
			stopped.abort()
			await expect(call).rejects.toMatchObject({ _tag: "APIUserAbortError" })
			expect(cancelled).toBe(1)
			expect(stream.locked).toBe(false)
		} finally {
			await client.close()
		}
	}, 2000)

	it("bounds an endless sequence of empty chunks by the request deadline", async () => {
		let cancelled = 0
		const stream = new ReadableStream<Uint8Array>({
			pull: (controller) => controller.enqueue(new Uint8Array(0)),
			cancel: () => {
				cancelled += 1
			},
		})
		const client = new Checkfu({ ...config, fetch: async () => new Response(stream) })
		try {
			await expect(
				client.artifacts.versions.content(
					artifact,
					version,
					{ file },
					{ timeout: 50, maxRetries: 0 },
				),
			).rejects.toMatchObject({ _tag: "APIConnectionTimeoutError" })
			expect(cancelled).toBe(1)
			expect(stream.locked).toBe(false)
		} finally {
			await client.close()
		}
	}, 2000)

	it("stops collection when a response exceeds the maximum File size", async () => {
		const chunk = new Uint8Array(MAX_ARTIFACT_FILE_BYTES / 8)
		let pulls = 0
		let requests = 0
		const client = new Checkfu({
			...config,
			fetch: async () => {
				requests += 1
				return new Response(
					new ReadableStream({
						pull: (controller) => {
							pulls += 1
							controller.enqueue(chunk)
							if (pulls === 12) {
								controller.close()
							}
						},
					}),
				)
			},
		})
		try {
			await expect(
				client.artifacts.versions.content(artifact, version, { file }),
			).rejects.toMatchObject({
				_tag: "APIConnectionError",
				retryable: false,
			})
			expect(requests).toBe(1)
			expect(pulls).toBeLessThan(12)
		} finally {
			await client.close()
		}
	})
})
