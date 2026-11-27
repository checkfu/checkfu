import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"

export interface ScriptedMcpServer {
	readonly url: string
	readonly methods: ReadonlyArray<string>
	readonly tokens: ReadonlyArray<string | undefined>
	readonly streamedRequests: ReadonlyArray<string | number>
	readonly closedStreams: ReadonlyArray<string | number>
	readonly cancellations: ReadonlyArray<string | number>
	readonly holdHandshakes: () => () => void
	readonly holdMethod: (method: string) => () => void
	readonly expireSessions: () => void
	readonly close: () => Promise<void>
}

interface Message {
	readonly id?: number | string
	readonly method?: string
	readonly params?: {
		readonly cursor?: string
		readonly name?: string
		readonly requestId?: string | number
		readonly arguments?: { readonly text?: string; readonly delay_ms?: number }
	}
}

const tool = (name: string, description: string) => ({
	name,
	description,
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
})

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
	}
	return Buffer.concat(chunks).toString("utf8")
}

export const startScriptedMcpServer = async (
	options: {
		readonly pages?: number
		readonly pageBytes?: number
		readonly protocolVersion?: string
		readonly stream?: "held" | "ping" | "silent"
		readonly callContent?: ReadonlyArray<unknown>
	} = {},
): Promise<ScriptedMcpServer> => {
	const methods: Array<string> = []
	const tokens: Array<string | undefined> = []
	const streamedRequests: Array<string | number> = []
	const closedStreams: Array<string | number> = []
	const cancellations: Array<string | number> = []
	const answers = new Map<string, () => void>()
	let pings = 0
	const sockets = new Set<Socket>()
	const sessions = new Set<string>()
	let opened = 0
	const held = new Map<string, Promise<void>>()
	const holdMethod = (method: string) => {
		const { promise, resolve } = Promise.withResolvers<void>()
		held.set(method, promise)
		return () => {
			held.delete(method)
			resolve()
		}
	}
	const pages = options.pages ?? 1

	const answer = async (
		message: Message,
		session: string | undefined,
		token: string,
	): Promise<{
		readonly result?: unknown
		readonly error?: unknown
		readonly session?: string
	}> => {
		switch (message.method) {
			case "server/discover":
				return options.protocolVersion === "2026-07-28"
					? {
							result: {
								supportedVersions: [options.protocolVersion],
								capabilities: { tools: {} },
								resultType: "complete",
								ttlMs: 0,
								cacheScope: "private",
							},
						}
					: { error: { code: -32_601, message: "Method not found" } }
			case "initialize": {
				const id = `scripted-${(opened += 1)}`
				sessions.add(id)
				return {
					session: id,
					result: {
						protocolVersion: options.protocolVersion ?? "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "scripted", version: "1.0.0" },
					},
				}
			}
			case "tools/list": {
				const page = Number(message.params?.cursor ?? 0)
				return {
					result: {
						tools: [
							...(page === 0
								? [
										tool("echo", "Echo a text back."),
										tool("boom", "Fails."),
										tool("leak", "Answers with the caller's credential."),
									]
								: []),
							...(pages > 1 ? [tool(`filler_${page}`, "x".repeat(options.pageBytes ?? 0))] : []),
						],
						...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}),
					},
				}
			}
			case "tools/call": {
				if (options.callContent !== undefined) {
					return { result: { content: options.callContent } }
				}
				if (message.params?.name === "boom") {
					return { error: { code: -32_000, message: "boom failed" } }
				}
				if (message.params?.name === "huge") {
					return {
						result: {
							content: [{ type: "text", text: "a large table" }],
							structuredContent: { rows: "x".repeat(300_000) },
						},
					}
				}
				if (message.params?.name === "leak") {
					const forms = [
						token,
						encodeURIComponent(token),
						new URLSearchParams({ s: token }).toString().slice(2),
						JSON.stringify(token).slice(1, -1),
					]
					return {
						result: {
							content: [{ type: "text", text: forms.join(" ") }],
							structuredContent: {
								nested: forms,
								[token]: `Bearer ${token}`,
								...(Number.isFinite(Number(token)) ? { number: Number(token) } : {}),
							},
						},
					}
				}
				const delay = message.params?.arguments?.delay_ms ?? 0
				await new Promise<void>((resolve) => {
					setTimeout(resolve, delay)
				})
				return {
					result: {
						content: [
							{
								type: "text",
								text: `echo:${message.params?.arguments?.text ?? ""}:${session ?? ""}`,
							},
						],
					},
				}
			}
			default:
				return { error: { code: -32_601, message: "Method not found" } }
		}
	}

	const http = createServer((request, response) => {
		void (async () => {
			const header = request.headers["mcp-session-id"]
			const session = typeof header === "string" ? header : undefined
			if (request.method !== "POST") {
				response.writeHead(request.method === "DELETE" ? 200 : 405).end()
				return
			}
			const authorization = request.headers.authorization
			const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : ""
			tokens.push(authorization === undefined ? undefined : token)
			const message = JSON.parse(await readBody(request)) as Message
			if (message.method === undefined) {
				answers.get(String(message.id))?.()
				response.writeHead(202).end()
				return
			}
			methods.push(message.method)
			if (session !== undefined && !sessions.has(session)) {
				response.writeHead(404).end()
				return
			}
			const paused = held.get(message.method)
			if (paused !== undefined) {
				await paused
			}
			if (message.id === undefined) {
				if (
					message.method === "notifications/cancelled" &&
					message.params?.requestId !== undefined
				) {
					cancellations.push(message.params.requestId)
				}
				response.writeHead(202).end()
				return
			}
			if (options.stream === "silent" && message.method === "tools/call") {
				const id = message.id
				streamedRequests.push(id)
				response.once("close", () => closedStreams.push(id))
				response.writeHead(200, { "content-type": "text/event-stream" })
				response.write(": waiting\n\n")
				return
			}
			const answered = await answer(message, session, token)
			if (options.stream !== undefined && message.method === "tools/call") {
				response.writeHead(200, { "content-type": "text/event-stream" })
				if (options.stream === "ping") {
					const id = `ping-${(pings += 1)}`
					const { promise: ponged, resolve } = Promise.withResolvers<void>()
					answers.set(id, resolve)
					response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n\n`)
					await ponged
				}
				const text = JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					...(answered.error === undefined
						? { result: answered.result }
						: { error: answered.error }),
				})
				const split = text.indexOf(",") + 1
				response.write(
					`event: message\ndata: ${text.slice(0, split)}\n: between\nid: ${token}\ndata: ${text.slice(split)}\n\n`,
				)
				return
			}
			response.writeHead(200, {
				"content-type": "application/json",
				...(answered.session === undefined ? {} : { "mcp-session-id": answered.session }),
			})
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					...(answered.error === undefined
						? { result: answered.result }
						: { error: answered.error }),
				}),
			)
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
		throw new Error("scripted MCP server has no port")
	}
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		methods,
		tokens,
		streamedRequests,
		closedStreams,
		cancellations,
		holdHandshakes: () => holdMethod("initialize"),
		holdMethod,
		expireSessions: () => sessions.clear(),
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy()
				}
				http.close(() => resolve())
			}),
	}
}
