import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import {
	McpServer,
	WebStandardStreamableHTTPServerTransport,
	createMcpHandler,
} from "@modelcontextprotocol/server"
import { z } from "zod"

export interface RecordedMcpToolCall {
	readonly tool: string
	readonly arguments: unknown
	readonly token: string | undefined
	readonly session: string | undefined
}

export interface FakeMcpServer {
	readonly url: string
	readonly calls: ReadonlyArray<RecordedMcpToolCall>
	readonly tokens: ReadonlyArray<string | undefined>
	readonly accept: (tokens: ReadonlyArray<string> | null) => void
	readonly sessions: () => number
	readonly close: () => Promise<void>
}

const readBody = async (request: IncomingMessage): Promise<string> => {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
	}
	return Buffer.concat(chunks).toString("utf8")
}

export const startFakeMcpServer = async (
	accepted: ReadonlyArray<string> | null,
	options: {
		readonly stateful?: boolean
		readonly modern?: boolean
	} = {},
): Promise<FakeMcpServer> => {
	const calls: Array<RecordedMcpToolCall> = []
	const tokens: Array<string | undefined> = []
	const sockets = new Set<Socket>()
	let acceptedTokens = accepted === null ? null : new Set(accepted)

	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>()
	let sessionCount = 0

	const serverFor = (token: string | undefined, session: () => string | undefined): McpServer => {
		const server = new McpServer({ name: "fake-mcp", version: "1.0.0" })
		server.registerTool(
			"echo",
			{
				description: "Echo a text back.",
				inputSchema: z.object({ text: z.string() }),
			},
			(args) => {
				calls.push({ tool: "echo", arguments: args, token, session: session() })
				return { content: [{ type: "text", text: `echo:${args.text}` }] }
			},
		)
		server.registerTool(
			"leak",
			{
				description: "Echo the caller's credential back, in every spelling.",
				inputSchema: z.object({}),
				outputSchema: z.object({
					nested: z.object({ secret: z.string(), list: z.array(z.string()) }),
				}),
			},
			() => {
				const secret = token ?? ""
				calls.push({ tool: "leak", arguments: {}, token, session: session() })
				const spellings = [
					secret,
					encodeURIComponent(secret),
					new URLSearchParams({ key: secret }).toString().slice(4),
					JSON.stringify(secret).slice(1, -1),
				]
				return {
					content: [{ type: "text", text: `sent ${spellings.join(" | ")}` }],
					structuredContent: { nested: { secret, list: spellings } },
				}
			},
		)
		return server
	}

	const http = createServer((request, response) => {
		void (async () => {
			const authorization = request.headers.authorization
			const token =
				authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : undefined
			tokens.push(token)
			if (acceptedTokens !== null && (token === undefined || !acceptedTokens.has(token))) {
				response.writeHead(401, { "www-authenticate": "Bearer", "content-type": "text/plain" })
				response.end("unauthorized")
				return
			}
			const body =
				request.method === "GET" || request.method === "HEAD" ? null : await readBody(request)
			const headers = new Headers()
			for (const [name, value] of Object.entries(request.headers)) {
				if (typeof value === "string") {
					headers.set(name, value)
				}
			}
			const url = `http://${request.headers.host ?? "127.0.0.1"}${request.url ?? "/"}`
			if (options.modern === true) {
				const answer = await createMcpHandler(() => serverFor(token, () => undefined), {
					legacy: "reject",
				}).fetch(
					new Request(url, {
						method: request.method ?? "POST",
						headers,
						...(body === null ? {} : { body }),
					}),
				)
				response.writeHead(answer.status, Object.fromEntries(answer.headers))
				response.end(new Uint8Array(await answer.arrayBuffer()))
				return
			}
			const known = request.headers["mcp-session-id"]
			let transport =
				options.stateful === true && typeof known === "string" ? transports.get(known) : undefined
			if (transport === undefined) {
				const created = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator:
						options.stateful === true ? () => `s${(sessionCount += 1)}` : undefined,
					onsessioninitialized: (id) => {
						transports.set(id, created)
					},
				})
				transport = created
				await serverFor(token, () => created.sessionId).connect(created)
			}
			const method = request.method ?? "POST"
			const answer = await transport.handleRequest(
				body === null
					? new Request(url, { method, headers })
					: new Request(url, { method, headers, body }),
			)
			response.writeHead(answer.status, Object.fromEntries(answer.headers))
			response.end(new Uint8Array(await answer.arrayBuffer()))
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
		throw new Error("fake MCP server has no port")
	}
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		calls,
		tokens,
		sessions: () => sessionCount,
		accept: (next) => {
			acceptedTokens = next === null ? null : new Set(next)
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy()
				}
				http.close(() => resolve())
			}),
	}
}
