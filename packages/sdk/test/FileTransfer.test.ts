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

	it("downloads a file's bytes", async () => {
		const client = new Checkfu({
			apiKey: "ck_test_key",
			baseUrl: "http://localhost:1337",
			fetch: async (input, init) => {
				expect(new URL(new Request(input, init).url).pathname).toBe(`/v1/files/${file.id}/content`)
				return new Response(new Uint8Array([104, 105]), {
					status: 200,
					headers: { "content-type": "text/plain" },
				})
			},
		})
		const bytes = await client.files.content(file.id)
		expect(new TextDecoder().decode(bytes)).toBe("hi")
	})

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
