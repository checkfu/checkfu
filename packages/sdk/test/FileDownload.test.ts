import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Checkfu } from "../src/Checkfu.ts"
import { CheckfuClient } from "../src/Client.ts"
import type { CheckfuSdkError } from "../src/Errors.ts"

const id = "file_0123456789abcdef0123456789abcdef"
const etag = '"version"'
const common = { apiKey: "ck_test_key", baseUrl: "http://localhost:1337" }
const effectContent = <T>(
	fetch: typeof globalThis.fetch,
	use: (client: typeof CheckfuClient.Service) => Effect.Effect<T, CheckfuSdkError>,
) =>
	Effect.runPromise(
		Effect.flatMap(CheckfuClient, use).pipe(
			Effect.provide(CheckfuClient.layerFetch({ ...common, fetch })),
		),
	)

describe("conditional file downloads", () => {
	it.each([
		{
			status: 206,
			headers: { range: "bytes=1-2", "if-range": etag },
			contentRange: "bytes 1-2/4",
			expected: [127, 255],
		},
		{
			status: 200,
			headers: { range: "bytes=1-2", "if-range": '"older"' },
			contentRange: null,
			expected: [0, 127, 255, 19],
		},
		{
			status: 304,
			headers: { "if-none-match": etag },
			contentRange: null,
			expected: [],
		},
	])(
		"decodes $status once for each facade and keeps the raw response",
		async ({ headers, status, expected, contentRange }) => {
			let calls = 0
			const fetch: typeof globalThis.fetch = async (input, init) => {
				calls += 1
				const request = new Request(input, init)
				expect(new URL(request.url).pathname).toBe("/v1/files/" + id + "/content")
				for (const [name, value] of Object.entries(headers)) {
					expect(request.headers.get(name)).toBe(value)
				}
				return new Response(status === 304 ? null : Uint8Array.from(expected), {
					status,
					headers: {
						etag,
						"content-type": "application/octet-stream",
						"request-id": "req_range",
						...(contentRange === null ? {} : { "content-range": contentRange }),
					},
				})
			}
			const client = new Checkfu({ ...common, fetch })
			try {
				const { data, response, requestId } = await client.files
					.content(id, { headers })
					.withResponse()
				expect([
					response.status,
					requestId,
					response.headers.get("etag"),
					response.headers.get("content-range"),
				]).toEqual([status, "req_range", etag, contentRange])
				expect(Array.from(data)).toEqual(expected)
				expect(response.body === null).toBe(status === 304)
				expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(expected)
				expect(calls).toBe(1)
			} finally {
				await client.close()
			}

			const effect = await effectContent(fetch, (client) =>
				client.files.content(id, { headers, withResponse: true }),
			)
			expect([
				effect.status,
				effect.requestId,
				effect.headers["etag"],
				effect.headers["content-range"] ?? null,
			]).toEqual([status, "req_range", etag, contentRange])
			expect(Array.from(effect.data)).toEqual(expected)
			expect(calls).toBe(2)
		},
	)

	it.each([
		[416, "UnexpectedStatusError", null],
		[401, "AuthenticationError", "authentication_error"],
		[404, "NotFoundError", "not_found"],
	] as const)("settles %i as a terminal error for both facades", async (status, tag, errorType) => {
		let calls = 0
		const fetch: typeof globalThis.fetch = async () => {
			calls += 1
			return errorType === null
				? new Response(null, {
						status,
						headers: { "content-range": "bytes */4", "x-should-retry": "true" },
					})
				: Response.json(
						{ type: "error", error: { type: errorType, message: "Refused." } },
						{ status },
					)
		}
		const client = new Checkfu({ ...common, fetch })
		try {
			await expect(
				client.files.content(id, { headers: { range: "bytes=9-20" } }),
			).rejects.toMatchObject({ _tag: tag, status })
			expect(calls).toBe(1)
		} finally {
			await client.close()
		}
		await expect(
			effectContent(fetch, (client) =>
				client.files.content(id, { headers: { range: "bytes=9-20" } }),
			),
		).rejects.toMatchObject({ _tag: tag, status })
		expect(calls).toBe(2)
	})

	it("aborts a stalled partial response while releasing its reader", async () => {
		const reading = Promise.withResolvers<void>()
		const releaseRead = Promise.withResolvers<void>()
		const releaseCancel = Promise.withResolvers<void>()
		const caller = new AbortController()
		let cancelled = 0
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					reading.resolve()
					return releaseRead.promise
				},
				cancel() {
					cancelled += 1
					return releaseCancel.promise
				},
			},
			{ highWaterMark: 0 },
		)
		const client = new Checkfu({
			...common,
			fetch: async () =>
				new Response(body, {
					status: 206,
					headers: { "content-type": "application/octet-stream", "content-range": "bytes 1-2/4" },
				}),
		})
		try {
			const received = client.files
				.content(id, { headers: { range: "bytes=1-2" }, signal: caller.signal })
				.catch((error: unknown) => error)
			await reading.promise
			caller.abort()
			expect(await received).toMatchObject({ _tag: "APIUserAbortError" })
			expect(cancelled).toBe(1)
			expect(body.locked).toBe(false)
		} finally {
			releaseCancel.resolve()
			releaseRead.resolve()
			await client.close()
		}
	})

	it("rejects explicit keys and mixed-case key headers before fetching", async () => {
		let calls = 0
		const fetch: typeof globalThis.fetch = async () => {
			calls += 1
			return new Response(null, { status: 304 })
		}
		const client = new Checkfu({ ...common, fetch })
		try {
			for (const options of [
				{ idempotencyKey: "key" },
				{ headers: { "IdEmPoTeNcY-KeY": "key" } },
			]) {
				const unchecked = options as Parameters<typeof client.files.content>[1]
				await expect(client.files.content(id, unchecked)).rejects.toMatchObject({
					_tag: "CheckfuConfigError",
				})
				await expect(
					effectContent(fetch, (client) => client.files.content(id, unchecked)),
				).rejects.toMatchObject({
					_tag: "CheckfuConfigError",
				})
			}
		} finally {
			await client.close()
		}
		expect(calls).toBe(0)
	})
})
