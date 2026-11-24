import {
	Client,
	SdkHttpError,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client"
import * as Schema from "effect/Schema"
import { McpToolDescriptors } from "./McpTools.ts"
import { boundStructured } from "./ResultBounds.ts"
import type {
	ForwardOutcome,
	ForwardRequest,
	McpCallOutcome,
	McpContent,
	McpFailure,
	McpFailureReason,
	McpListOutcome,
} from "./McpTools.ts"

export { McpToolDescriptor, McpToolDescriptors } from "./McpTools.ts"
export type {
	McpCallOutcome,
	McpContent,
	McpFailure,
	McpFailureReason,
	McpListOutcome,
	McpTarget,
} from "./McpTools.ts"

const decodeTools = Schema.decodeUnknownSync(McpToolDescriptors)

/** A connection's answer that carries no response: the reason travels to the caller as it is. */
const forwardFailures = new WeakMap<object, McpFailure>()

const forwardFailed = (failure: McpFailure): Error => {
	const error = new Error(failure.message)
	forwardFailures.set(error, failure)
	return error
}

const forwardFailure = (error: unknown): McpFailure | undefined =>
	typeof error === "object" && error !== null ? forwardFailures.get(error) : undefined

const failure = (reason: McpFailureReason, message: string): McpFailure => ({
	ok: false,
	reason,
	message,
})

const failed = (error: unknown): McpFailure => {
	const forwarded = forwardFailure(error)
	if (forwarded !== undefined) {
		return forwarded
	}
	const status = SdkHttpError.isInstance(error) ? error.status : undefined
	if (UnauthorizedError.isInstance(error) || status === 401) {
		return failure("unauthorized", "The MCP server did not accept the credential (401).")
	}
	if (status === 403) {
		return failure("forbidden", "The MCP server refused the request (403).")
	}
	return failure("failed", `The MCP server request failed: ${String(error)}`)
}

const requestHeaders = (headers: HeadersInit | undefined): Array<[string, string]> => [
	...new Headers(headers),
]

/**
 * A session's MCP client for one server. It keeps the session's own MCP
 * state, such as the session id a stateful server hands out, so no two
 * sessions share it; every request goes through the connection that holds
 * the server's credential, which sends it and cleans the answer.
 */
export const makeMcpUpstream = (
	url: string,
	forward: (request: ForwardRequest) => Promise<ForwardOutcome>,
) => {
	let connected: Client | undefined

	const viaConnection = async (input: string | URL | Request, init?: RequestInit) => {
		const answer = await forward({
			method: init?.method ?? "GET",
			url: typeof input === "string" ? input : "href" in input ? input.href : input.url,
			headers: requestHeaders(init?.headers),
			body: typeof init?.body === "string" ? init.body : null,
		})
		if (!answer.ok) {
			throw forwardFailed(answer)
		}
		return new Response(answer.body.length === 0 ? null : answer.body, {
			status: answer.status,
			headers: answer.headers.map(([name, value]) => [name, value]),
		})
	}

	const drop = async () => {
		const current = connected
		connected = undefined
		await current?.close().catch(() => undefined)
	}

	const connect = async (): Promise<Client> => {
		if (connected !== undefined) {
			return connected
		}
		const client = new Client({ name: "checkfu", version: "1" })
		await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: viaConnection }))
		connected = client
		return client
	}

	const run = async <A>(request: (client: Client) => Promise<A>): Promise<A | McpFailure> => {
		try {
			return await request(await connect())
		} catch (error) {
			await drop()
			return failed(error)
		}
	}

	return {
		listTools: (): Promise<McpListOutcome> =>
			run(async (client) => {
				const { tools } = await client.listTools()
				return {
					ok: true as const,
					tools: decodeTools(
						tools.map((tool) => ({
							name: tool.name,
							description: tool.description ?? "",
							inputSchema: tool.inputSchema,
							...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
							...(tool.annotations?.readOnlyHint === true ? { readOnly: true as const } : {}),
						})),
					),
				}
			}),
		callTool: (name: string, args: Schema.JsonObject): Promise<McpCallOutcome> =>
			run(async (client) => {
				const result = await client.callTool({ name, arguments: args })
				const content = result.content.map((block): McpContent => {
					if (block.type === "text") {
						return { type: "text", text: block.text }
					}
					if (block.type === "image") {
						return { type: "image", data: block.data, mimeType: block.mimeType }
					}
					if (block.type === "resource" && "text" in block.resource) {
						return { type: "text", text: block.resource.text }
					}
					return { type: "text", text: `[${block.type}]` }
				})
				// Images are bounded where every tool's are, by the session's result hook; structured
				// content is bounded here, before a script sees it.
				const structured = boundStructured(result.structuredContent)
				return {
					ok: true as const,
					content: [
						...content,
						...(structured.dropped === undefined
							? []
							: [{ type: "text" as const, text: structured.dropped }]),
					],
					...(structured.value === undefined ? {} : { structuredContent: structured.value }),
					isError: result.isError === true,
				}
			}),
		close: drop,
	}
}

export type McpUpstream = ReturnType<typeof makeMcpUpstream>
