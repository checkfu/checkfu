import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import type * as Schema from "effect/Schema"

export interface RecordedApiRequest {
	readonly method: string
	/** The path and query exactly as they arrived, before any decoding. */
	readonly target: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string
}

/** Where the API looks for its key, and the keys it accepts; null accepts requests without one. */
export type FakeApiAuth =
	| { readonly in: "header"; readonly name: string; readonly prefix?: string }
	| { readonly in: "query"; readonly name: string }

export interface FakeHttpApi {
	readonly baseUrl: string
	readonly spec: Schema.JsonObject
	/** Every request the API answered or refused, in order. */
	readonly requests: ReadonlyArray<RecordedApiRequest>
	readonly accept: (keys: ReadonlyArray<string> | null) => void
	readonly close: () => Promise<void>
}

export const BIG_BODY_BYTES = 700 * 1024

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
	}
	return Buffer.concat(chunks).toString("utf8")
}

const SPEC: Schema.JsonObject = {
	openapi: "3.0.3",
	info: { title: "Pet shop", version: "1.2.3" },
	paths: {
		"/pets/{petId}": {
			get: {
				operationId: "getPet",
				summary: "Look a pet up by id.",
				tags: ["pets"],
				parameters: [
					{ name: "petId", in: "path", required: true, schema: { type: "string" } },
					{ name: "verbose", in: "query", schema: { type: "boolean" } },
				],
				responses: {
					"200": {
						description: "The pet",
						content: {
							"application/json": { schema: { $ref: "#/components/schemas/Pet" } },
						},
					},
				},
			},
		},
		"/pets": {
			post: {
				operationId: "createPet",
				summary: "Add a pet.",
				tags: ["pets"],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { name: { type: "string" } },
								required: ["name"],
							},
						},
					},
				},
				responses: {
					"201": {
						description: "The pet",
						content: {
							"application/json": { schema: { $ref: "#/components/schemas/Pet" } },
						},
					},
				},
			},
		},
		"/echo": {
			get: {
				operationId: "echoRequest",
				summary: "Say what the request looked like.",
				tags: ["debug"],
				responses: { "200": { description: "The request, as received" } },
			},
		},
		"/missing": {
			get: {
				operationId: "getMissing",
				summary: "Always answers 404.",
				tags: ["debug"],
				responses: { "404": { description: "Not found" } },
			},
		},
		"/big": {
			get: {
				operationId: "getBig",
				summary: "Answers with a very long body.",
				tags: ["debug"],
				responses: { "200": { description: "A long text" } },
			},
		},
	},
	components: {
		schemas: {
			Pet: {
				type: "object",
				properties: { id: { type: "string" }, name: { type: "string" } },
				required: ["id"],
			},
		},
	},
}

/**
 * A small HTTP API under `/v1`, described by an OpenAPI document. It records
 * every request as it arrived and answers 401 to one without an accepted key.
 * `GET /echo` answers with the request's own URL and headers, key included.
 */
export const startFakeHttpApi = async (
	auth: FakeApiAuth | null,
	accepted: ReadonlyArray<string> | null,
): Promise<FakeHttpApi> => {
	const requests: Array<RecordedApiRequest> = []
	const sockets = new Set<Socket>()
	let acceptedKeys = accepted === null ? null : new Set(accepted)

	const presented = (request: IncomingMessage, url: URL): string | undefined => {
		if (auth === null) {
			return undefined
		}
		if (auth.in === "query") {
			return url.searchParams.get(auth.name) ?? undefined
		}
		const value = request.headers[auth.name.toLowerCase()]
		const prefix = auth.prefix ?? ""
		return typeof value === "string" && value.startsWith(prefix)
			? value.slice(prefix.length)
			: undefined
	}

	const http = createServer((request, response) => {
		const json = (status: number, value: unknown) => {
			response.writeHead(status, { "content-type": "application/json" })
			response.end(JSON.stringify(value))
		}
		void (async () => {
			const target = request.url ?? "/"
			const url = new URL(target, "http://fake.api")
			const headers = Object.fromEntries(
				Object.entries(request.headers).flatMap(([name, value]) =>
					typeof value === "string" ? [[name, value]] : [],
				),
			)
			const body = await readBody(request)
			requests.push({ method: request.method ?? "GET", target, headers, body })
			const key = presented(request, url)
			if (acceptedKeys !== null && (key === undefined || !acceptedKeys.has(key))) {
				json(401, { error: "unauthorized" })
				return
			}
			const pet = /^\/v1\/pets\/([^/]+)$/u.exec(url.pathname)
			if (request.method === "GET" && pet !== null) {
				json(200, { id: decodeURIComponent(pet[1] ?? ""), name: "Rex" })
				return
			}
			if (request.method === "POST" && url.pathname === "/v1/pets") {
				const parsed = JSON.parse(body) as { readonly name?: string }
				json(201, { id: `pet_${requests.length}`, name: parsed.name ?? "" })
				return
			}
			if (request.method === "GET" && url.pathname === "/v1/echo") {
				json(200, { url: target, headers })
				return
			}
			if (request.method === "GET" && url.pathname === "/v1/big") {
				response.writeHead(200, { "content-type": "text/plain" })
				response.end("x".repeat(BIG_BODY_BYTES))
				return
			}
			json(404, { error: "not found", path: url.pathname })
		})().catch((error: unknown) => {
			response.writeHead(500, { "content-type": "text/plain" })
			response.end(String(error))
		})
	})
	http.on("connection", (socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
	})
	await new Promise<void>((resolve) => {
		http.listen(0, "127.0.0.1", resolve)
	})
	const address = http.address()
	if (address === null || typeof address === "string") {
		throw new Error("fake HTTP API has no port")
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		spec: SPEC,
		requests,
		accept: (next) => {
			acceptedKeys = next === null ? null : new Set(next)
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy()
				}
				http.close(() => {
					resolve()
				})
			}),
	}
}
