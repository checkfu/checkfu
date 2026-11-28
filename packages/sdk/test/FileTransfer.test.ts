import { describe, expect, it } from "@effect/vitest"
import { Checkfu } from "../src/Checkfu.ts"

const file = {
	id: "file_0123456789abcdef0123456789abcdef",
	type: "file",
	filename: "report.html",
	content_type: "text/html",
	size: 5,
	sha256: "a".repeat(64),
	origin: { type: "upload" },
	created_at: "2026-11-28T00:00:00.000Z",
}

describe("files.upload / files.content (hand-written: Forge skips byte bodies)", () => {
	it("uploads raw bytes with the filename and content type, and decodes the File", async () => {
		const seen: Array<{
			url: string
			method: string
			body: Uint8Array
			contentType: string | null
			key: string | null
		}> = []
		const client = new Checkfu({
			apiKey: "ck_test_key",
			baseUrl: "http://localhost:1337",
			fetch: async (input, init) => {
				const request = new Request(input, init)
				seen.push({
					url: request.url,
					method: request.method,
					body: new Uint8Array(await request.arrayBuffer()),
					contentType: request.headers.get("content-type"),
					key: request.headers.get("idempotency-key"),
				})
				return Response.json(file, { status: 201 })
			},
		})
		const created = await client.files.upload(
			{
				body: new TextEncoder().encode("hello"),
				filename: "report.html",
				content_type: "text/html",
			},
			{ idempotencyKey: "upload-report-1" },
		)
		expect(created.id).toBe(file.id)
		expect(seen[0]?.method).toBe("POST")
		expect(new URL(seen[0]!.url).pathname).toBe("/v1/files")
		expect(new URL(seen[0]!.url).searchParams.get("filename")).toBe("report.html")
		expect(seen[0]?.contentType).toBe("application/octet-stream")
		expect(new TextDecoder().decode(seen[0]!.body)).toBe("hello")
		expect(seen[0]?.key).toBe("upload-report-1")
	})

	it("accepts Blob and ArrayBuffer bodies", async () => {
		const sizes: Array<number> = []
		const client = new Checkfu({
			apiKey: "ck_test_key",
			baseUrl: "http://localhost:1337",
			fetch: async (input, init) => {
				sizes.push((await new Request(input, init).arrayBuffer()).byteLength)
				return Response.json(file, { status: 201 })
			},
		})
		await client.files.upload({ body: new Blob(["abc"]), filename: "a.txt" })
		await client.files.upload({ body: new Uint8Array([1, 2, 3, 4]).buffer, filename: "b.bin" })
		expect(sizes).toEqual([3, 4])
	})

	it.each([{ expected: [0, 127, 255] }, { expected: [] }])(
		"preserves downloaded bytes through each response accessor ($expected)",
		async ({ expected }) => {
			const bytes = Uint8Array.from([19, ...expected, 23]).subarray(1, -1)
			let requests = 0
			const client = new Checkfu({
				apiKey: "ck_test_key",
				baseUrl: "http://localhost:1337",
				fetch: async (input, init) => {
					requests += 1
					expect(new URL(new Request(input, init).url).pathname).toBe(
						`/v1/files/${file.id}/content`,
					)
					return new Response(new Uint8Array(bytes), {
						status: 200,
						headers: { "content-type": "application/octet-stream", "request-id": "req_download" },
					})
				},
			})
			const direct = client.files.content(file.id)
			const decoded = await direct
			expect(Array.from(decoded)).toEqual(expected)
			decoded.fill(5)
			const response = await direct.asResponse()
			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("application/octet-stream")
			expect(response.headers.get("request-id")).toBe("req_download")
			expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(expected)
			expect(requests).toBe(1)

			const {
				data,
				response: raw,
				status,
				requestId,
			} = await client.files.content(file.id).withResponse()
			expect([status, requestId]).toEqual([200, "req_download"])
			expect(Array.from(data)).toEqual(expected)
			data.fill(0)
			expect(Array.from(new Uint8Array(await raw.arrayBuffer()))).toEqual(expected)
			expect(requests).toBe(2)
		},
	)

	it("keeps the generated file methods", () => {
		const client = new Checkfu({
			apiKey: "ck_test_key",
			baseUrl: "http://localhost:1337",
			fetch: async () => new Response(null),
		})
		expect(typeof client.files.list).toBe("function")
		expect(typeof client.files.retrieve).toBe("function")
		expect(typeof client.files.delete).toBe("function")
	})
})
