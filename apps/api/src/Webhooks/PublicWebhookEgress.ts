import * as dns from "node:dns"
import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
import type { LookupAddress } from "node:dns"
import { isPublicIpAddress, parsePublicHttpsWebhookUrl } from "@checkfu/sdk/WebhookUrl"
import {
	WEBHOOK_EGRESS_TARGET_HEADER,
	WEBHOOK_EGRESS_TIMEOUT_HEADER,
} from "./WebhookEgressConfig.ts"
import type { WebhookHttpResult } from "./WebhookDeliveryEngine.ts"

const MAX_EGRESS_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000
const FORWARDED_HEADERS = [
	"user-agent",
	"content-type",
	"webhook-id",
	"webhook-timestamp",
	"webhook-signature",
] as const

export type DnsLookupAll = (hostname: string) => Promise<ReadonlyArray<LookupAddress>>

export interface PublicWebhookEgressOptions {
	readonly token?: string
	readonly lookupAll?: DnsLookupAll
	readonly httpsRequest?: typeof https.request
}

export interface PublicWebhookEgressServer {
	readonly url: string
	readonly close: () => Promise<void>
}

class BlockedDestinationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "BlockedDestinationError"
	}
}

const defaultLookupAll: DnsLookupAll = (hostname) =>
	dns.promises.lookup(hostname, { all: true, verbatim: true })

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		let total = 0
		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength
			if (total > MAX_EGRESS_BODY_BYTES) {
				req.destroy(new Error("Request body exceeds maximum webhook payload size."))
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => resolve(Buffer.concat(chunks)))
		req.on("error", reject)
	})

const parseTimeoutMs = (header: string | undefined): number => {
	if (header === undefined) {
		return DEFAULT_TIMEOUT_MS
	}
	const parsed = Number(header)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_TIMEOUT_MS
	}
	return Math.min(MAX_TIMEOUT_MS, Math.max(500, Math.floor(parsed)))
}

/**
 * Executes a single outbound HTTPS webhook POST while enforcing public-only
 * destinations at actual connection time:
 * 1. Validates and canonicalizes the HTTPS destination URL.
 * 2. Resolves DNS and verifies EVERY returned A/AAAA record is publicly routable.
 * 3. Pins the TCP connection to a verified public IP while preserving the
 *    original hostname for TLS SNI and certificate verification.
 * 4. Re-verifies `socket.remoteAddress` upon TCP/TLS connect before writing bytes.
 * 5. Never follows HTTP redirects.
 */
export const deliverThroughPublicHttps = async (input: {
	readonly targetUrl: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: Buffer
	readonly timeoutMs: number
	readonly lookupAll?: DnsLookupAll
	readonly httpsRequest?: typeof https.request
}): Promise<WebhookHttpResult> => {
	const canonical = parsePublicHttpsWebhookUrl(input.targetUrl)
	if (canonical === null) {
		return {
			kind: "invalid_destination",
			message: "Webhook destination URL is not a permitted public HTTPS address.",
		}
	}
	const parsed = new URL(canonical)
	const hostname =
		parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
			? parsed.hostname.slice(1, -1)
			: parsed.hostname
	const ipFamily = net.isIP(hostname)
	const port = parsed.port.length > 0 ? Number(parsed.port) : 443
	const lookupAll = input.lookupAll ?? defaultLookupAll
	const requestFn = input.httpsRequest ?? https.request

	// Resolve and validate every IP upfront so a host with any private record is refused.
	let addresses: ReadonlyArray<LookupAddress>
	if (ipFamily !== 0) {
		addresses = [{ address: hostname, family: ipFamily }]
	} else {
		try {
			addresses = await lookupAll(hostname)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return { kind: "network_error", message: `DNS resolution failed: ${message}` }
		}
	}
	if (addresses.length === 0) {
		return { kind: "network_error", message: "DNS resolution returned no addresses." }
	}
	for (const entry of addresses) {
		if (!isPublicIpAddress(entry.address)) {
			return {
				kind: "invalid_destination",
				message: `Refusing webhook connection to non-public IP address (${entry.address}).`,
			}
		}
	}
	const [chosen] = addresses
	if (chosen === undefined) {
		return { kind: "network_error", message: "DNS resolution returned no addresses." }
	}

	return await new Promise<WebhookHttpResult>((resolve) => {
		let settled = false
		const finish = (result: WebhookHttpResult) => {
			if (!settled) {
				settled = true
				resolve(result)
			}
		}

		const outboundHeaders: http.OutgoingHttpHeaders = {
			host: parsed.host,
			"content-length": String(input.body.byteLength),
		}
		for (const key of FORWARDED_HEADERS) {
			const value = input.headers[key]
			if (value !== undefined) {
				outboundHeaders[key] = value
			}
		}

		const req = requestFn(
			{
				protocol: "https:",
				hostname,
				port,
				path: `${parsed.pathname}${parsed.search}`,
				method: "POST",
				headers: outboundHeaders,
				agent: false,
				...(ipFamily === 0 ? { servername: hostname } : {}),
				rejectUnauthorized: true,
				lookup: (_hostname, options, callback) => {
					if (typeof options === "object" && options !== null && options.all === true) {
						callback(null, [{ address: chosen.address, family: chosen.family }])
						return
					}
					callback(null, chosen.address, chosen.family)
				},
			},
			(res) => {
				const status = res.statusCode ?? 502
				res.resume()
				res.destroy()
				finish({ kind: "response", status })
			},
		)

		req.on("socket", (socket) => {
			const verifyPeerAddress = () => {
				const peer = socket.remoteAddress
				if (peer === undefined || !isPublicIpAddress(peer)) {
					socket.destroy(
						new BlockedDestinationError(
							`Refusing webhook connection to non-public peer address (${peer ?? "unknown"}).`,
						),
					)
				}
			}
			if (!socket.connecting) {
				verifyPeerAddress()
			}
			socket.once("connect", verifyPeerAddress)
			socket.once("secureConnect", verifyPeerAddress)
		})

		req.setTimeout(input.timeoutMs, () => {
			req.destroy()
			finish({ kind: "timeout" })
		})

		req.on("error", (error) => {
			if (error instanceof BlockedDestinationError) {
				finish({ kind: "invalid_destination", message: error.message })
				return
			}
			finish({
				kind: "network_error",
				message: error instanceof Error ? error.message : String(error),
			})
		})

		req.end(input.body)
	})
}

const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(Buffer.byteLength(body)),
	})
	res.end(body)
}

/**
 * Starts a local/self-hosted public-only webhook egress HTTP server.
 * Binds to `127.0.0.1` by default and validates every outbound HTTPS connection
 * against `isPublicIpAddress` at DNS lookup AND socket connect time.
 */
export const startPublicWebhookEgressServer = async (
	options: PublicWebhookEgressOptions = {},
): Promise<PublicWebhookEgressServer> => {
	const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed." })
			return
		}
		if (options.token !== undefined) {
			const auth = req.headers.authorization
			if (auth !== `Bearer ${options.token}`) {
				sendJson(res, 401, { error: "Unauthorized." })
				return
			}
		}
		const targetHeader = req.headers[WEBHOOK_EGRESS_TARGET_HEADER]
		const targetUrl = typeof targetHeader === "string" ? targetHeader : ""
		if (targetUrl.length === 0) {
			sendJson(res, 400, { error: `Missing ${WEBHOOK_EGRESS_TARGET_HEADER} header.` })
			return
		}
		const timeoutHeader = req.headers[WEBHOOK_EGRESS_TIMEOUT_HEADER]
		const timeoutMs = parseTimeoutMs(typeof timeoutHeader === "string" ? timeoutHeader : undefined)

		let body: Buffer
		try {
			body = await readBody(req)
		} catch (error) {
			sendJson(res, 413, { error: error instanceof Error ? error.message : String(error) })
			return
		}

		const forwarded: Record<string, string> = {}
		for (const key of FORWARDED_HEADERS) {
			const raw = req.headers[key]
			if (typeof raw === "string") {
				forwarded[key] = raw
			}
		}
		const result = await deliverThroughPublicHttps({
			targetUrl,
			headers: forwarded,
			body,
			timeoutMs,
			...(options.lookupAll === undefined ? {} : { lookupAll: options.lookupAll }),
			...(options.httpsRequest === undefined ? {} : { httpsRequest: options.httpsRequest }),
		})
		sendJson(res, 200, result)
	}

	const server = http.createServer((req, res) => {
		void handleRequest(req, res).catch((error: unknown) => {
			if (!res.headersSent) {
				sendJson(res, 500, {
					error: error instanceof Error ? error.message : "Webhook egress internal error.",
				})
			}
		})
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			resolve()
		})
	})
	const address = server.address()
	if (address === null || typeof address === "string") {
		throw new Error("Webhook egress server failed to bind a TCP port.")
	}
	return {
		url: `http://127.0.0.1:${address.port}/egress`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error !== undefined && error !== null) {
						reject(error)
					} else {
						resolve()
					}
				})
			}),
	}
}
