import type { ForwardOutcome, ForwardRequest, McpFailure, McpTarget } from "./McpTools.ts"
import { makeScrubber } from "./Scrub.ts"

/** Longest one forwarded request may take, response body included. */
export const FORWARD_TIMEOUT_MS = 60_000

/** Response bytes one forwarded request may return. */
export const MAX_FORWARD_RESPONSE_BYTES = 4 * 1024 * 1024

/** Request headers a caller may set; everything else, credentials included, is the proxy's. */
const REQUEST_HEADERS = new Set([
	"accept",
	"content-type",
	"last-event-id",
	"mcp-protocol-version",
	"mcp-session-id",
])

/** Response headers that reach the caller. */
const RESPONSE_HEADERS = new Set(["content-type", "mcp-protocol-version", "mcp-session-id"])

const failure = (reason: McpFailure["reason"], message: string): McpFailure => ({
	ok: false,
	reason,
	message,
})

const CREDENTIAL_UNAVAILABLE = failure(
	"credential_unavailable",
	"The credential for this MCP server is no longer available.",
)

/** Reads at most `limit` bytes of a body; undefined when it holds more. */
const readBounded = async (response: Response, limit: number): Promise<string | undefined> => {
	if (response.body === null) {
		return ""
	}
	const reader = response.body.getReader()
	const chunks: Array<Uint8Array> = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		size += value.byteLength
		if (size > limit) {
			await reader.cancel()
			return undefined
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes)
}

/**
 * A connection's one way out. A caller hands it a request for the server the
 * connection was stored for; it sends it only there, with the credential it
 * holds, follows no redirect, bounds the time and the answer, and removes
 * every spelling of the credential from what comes back. The caller never
 * holds the secret, and keeps its own protocol state, such as an MCP session.
 */
export const makeConnectionProxy = (
	target: () => McpTarget | null,
	fetchFn: typeof fetch = fetch,
) => ({
	forward: async (request: ForwardRequest): Promise<ForwardOutcome> => {
		const to = target()
		if (to === null) {
			return CREDENTIAL_UNAVAILABLE
		}
		if (request.url !== to.url) {
			return failure("wrong_server", "This connection is for a different MCP server.")
		}
		// No standing stream: a held-open GET would outlive any bound this proxy sets.
		if (request.method === "GET") {
			return { ok: true, status: 405, headers: [["allow", "POST, DELETE"]], body: "" }
		}
		const secret = to.token === null ? null : to.token()
		if (to.token !== null && secret === null) {
			return CREDENTIAL_UNAVAILABLE
		}
		const scrub = makeScrubber(secret === null ? [] : [secret])
		const headers = new Headers(
			request.headers.flatMap(([name, value]): Array<[string, string]> =>
				REQUEST_HEADERS.has(name.toLowerCase()) ? [[name, value]] : [],
			),
		)
		if (secret !== null) {
			headers.set("authorization", `Bearer ${secret}`)
		}
		try {
			const response = await fetchFn(to.url, {
				method: request.method,
				headers,
				...(request.body === null ? {} : { body: request.body }),
				redirect: "manual",
				signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
			})
			const body = await readBounded(response, MAX_FORWARD_RESPONSE_BYTES)
			if (body === undefined) {
				return failure(
					"failed",
					`The MCP server's answer was larger than ${MAX_FORWARD_RESPONSE_BYTES} bytes, so it was not read.`,
				)
			}
			return {
				ok: true,
				status: response.status,
				headers: [...response.headers].flatMap(([name, value]) =>
					RESPONSE_HEADERS.has(name.toLowerCase()) ? [[name, scrub.text(value)] as const] : [],
				),
				body: scrub.body(response.headers.get("content-type"), body),
			}
		} catch (error) {
			return failure("failed", scrub.text(`The MCP server request failed: ${String(error)}`))
		}
	},
})

export type ConnectionProxy = ReturnType<typeof makeConnectionProxy>
