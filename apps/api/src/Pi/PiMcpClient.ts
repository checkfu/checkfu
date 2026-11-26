import * as McpClient from "effect/ai/McpClient"
import type { McpClientError } from "effect/ai/McpClientError"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { MAX_MCP_RESPONSE_BYTES, McpCall, McpToolDescriptors } from "./PiMcpTypes.ts"
import type {
	McpCallOutcome,
	McpCallScope,
	McpContent,
	McpExit,
	McpToolDescriptor,
} from "./PiMcpTypes.ts"

export const MAX_STRUCTURED_CHARS = 262_144

const passesOut = (name: string): boolean => {
	const lower = name.toLowerCase()
	return lower === "accept" || lower === "content-type" || lower.startsWith("mcp-")
}

const BEARER = "Bearer "

const metered = (response: Response, budget: McpCallScope["budget"]): Response => {
	if (response.body === null) {
		return response
	}
	const meter = new TransformStream<Uint8Array, Uint8Array>({
		transform: (chunk, controller) => {
			budget.bytes += chunk.byteLength
			if (budget.bytes > budget.limit) {
				budget.exceeded = true
				controller.error(new Error("The MCP server sent more than this call may read."))
				return
			}
			controller.enqueue(chunk)
		},
	})
	return new Response(response.body.pipeThrough(meter), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

const leaving = (target: string, exit: McpExit, fetchFn: typeof fetch): HttpClient.HttpClient =>
	HttpClient.make((request, url, interrupted) =>
		Effect.gen(function* () {
			const call = yield* McpCall
			const refuse = (description: string) =>
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({ request, description }),
				})
			if (url.href !== target) {
				return yield* refuse("This connection is for a different MCP server.")
			}
			const pass = exit(target, call)
			if ("refused" in pass) {
				return yield* refuse(pass.refused)
			}
			const headers = new Headers(
				Object.entries(request.headers).filter(([name]) => passesOut(name)),
			)
			if (pass.token !== null) {
				headers.set("authorization", `${BEARER}${pass.token}`)
				const sent = headers.get("authorization") ?? ""
				call.sent.add(pass.token)
				call.sent.add(sent.startsWith(BEARER) ? sent.slice(BEARER.length) : sent)
			}
			const response = yield* Effect.tryPromise({
				try: () =>
					fetchFn(target, {
						method: request.method,
						headers,
						...(request.body._tag === "Uint8Array"
							? { body: new TextDecoder().decode(request.body.body) }
							: {}),
						redirect: "manual",
						signal:
							call.signal === undefined ? interrupted : AbortSignal.any([interrupted, call.signal]),
					}),
				catch: (cause) => refuse(`The MCP server request failed: ${String(cause)}`),
			})
			return HttpClientResponse.fromWeb(request, metered(response, call.budget))
		}),
	)

const ANOTHER_PROTOCOL = new Set([400, 404, 405, 406, 415])

const speaksAnotherProtocol = (error: McpClientError): boolean => {
	const { reason } = error
	return (
		reason._tag === "ProtocolError" ||
		reason._tag === "UnsupportedError" ||
		(reason._tag === "HttpError" && ANOTHER_PROTOCOL.has(reason.status))
	)
}

export const connectMcp = (
	url: string,
	exit: McpExit,
	fetchFn: typeof fetch = fetch,
): Effect.Effect<McpClient.McpClient, McpClientError, Scope.Scope> => {
	const target = new URL(url).href
	const speaking = (protocol: (typeof McpProtocol)["v2026_07_28" | "v2025_11_25"]) =>
		McpClient.make({ name: "checkfu", version: "1" }).pipe(
			Effect.provideServiceEffect(
				McpClient.Transport,
				McpClient.http({ url: target, protocol, maxMessageBytes: MAX_MCP_RESPONSE_BYTES }),
			),
			Effect.provideService(HttpClient.HttpClient, leaving(target, exit, fetchFn)),
		)
	return speaking(McpProtocol.v2026_07_28).pipe(
		Effect.catchIf(speaksAnotherProtocol, () => speaking(McpProtocol.v2025_11_25)),
	)
}

const decodeTools = Schema.decodeUnknownOption(McpToolDescriptors)

export const listMcpTools = (
	client: McpClient.McpClient,
): Effect.Effect<Option.Option<ReadonlyArray<McpToolDescriptor>>, McpClientError> =>
	Effect.map(client.listTools(), (tools) =>
		decodeTools(
			tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
				...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
				...(typeof tool.annotations?.readOnlyHint === "boolean"
					? { annotations: { readOnlyHint: tool.annotations.readOnlyHint } }
					: {}),
			})),
		),
	)

const content = (block: McpSchema.ContentBlock): McpContent => {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text }
		case "image":
			return { type: "image", data: Base64.encode(block.data), mimeType: block.mimeType }
		case "resource":
			return "text" in block.resource
				? { type: "text", text: block.resource.text }
				: { type: "text", text: `[${block.resource.mimeType ?? "binary"} resource]` }
		default:
			return { type: "text", text: `[${block.type}]` }
	}
}

const asTool = Schema.decodeUnknownOption(McpSchema.Tool)
const isJson = Schema.is(Schema.Json)

export const callMcpTool = (
	client: McpClient.McpClient,
	descriptor: McpToolDescriptor,
	args: Schema.JsonObject,
): Effect.Effect<McpCallOutcome, McpClientError> =>
	Option.match(asTool(descriptor), {
		onNone: () =>
			Effect.succeed({
				ok: false as const,
				message: "The MCP tool's stored description is unreadable.",
			}),
		onSome: (tool) =>
			Effect.map(client.callTool({ tool, arguments: args }), (result) => {
				const blocks = result.content.map(content)
				const structured = isJson(result.structuredContent) ? result.structuredContent : undefined
				const size = structured === undefined ? 0 : JSON.stringify(structured).length
				if (size > MAX_STRUCTURED_CHARS) {
					return {
						ok: true as const,
						content: [
							{
								type: "text" as const,
								text: `The tool ran, but its structured result of ${size} characters was left out: a tool result carries at most ${MAX_STRUCTURED_CHARS}.`,
							},
							...blocks,
						],
						isError: true,
					}
				}
				return {
					ok: true as const,
					content: blocks,
					...(structured === undefined ? {} : { structuredContent: structured }),
					isError: result.isError === true,
				}
			}),
	})

export const describeMcpFailure = (error: McpClientError): string => {
	const { reason } = error
	if (reason._tag === "HttpError" && reason.status === 401) {
		return "The MCP server did not accept the credential (401)."
	}
	if (reason._tag === "HttpError" && reason.status === 403) {
		return "The MCP server refused the request (403)."
	}
	if (reason._tag === "HttpError" && reason.status === 429) {
		return reason.retryAfter === undefined
			? "The MCP server is limiting requests (429). Try again later."
			: `The MCP server is limiting requests (429). Try again after ${reason.retryAfter}.`
	}
	const cause = reason._tag === "TransportError" ? reason.cause : undefined
	return HttpClientError.isHttpClientError(cause) && cause.reason.description !== undefined
		? cause.reason.description
		: `The MCP server request failed: ${reason.message}`
}

export const mcpClientEnded = (error: McpClientError): boolean =>
	error.reason._tag === "ClosedError"
