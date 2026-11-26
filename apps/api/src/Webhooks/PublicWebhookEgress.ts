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

type LookupWithDeadlineResult =
	| { readonly kind: "ok"; readonly addresses: ReadonlyArray<LookupAddress> }
	| { readonly kind: "timeout" }
	| { readonly kind: "error"; readonly message: string }

const lookupWithinDeadline = (
	lookupAll: DnsLookupAll,
	hostname: string,
	timeoutMs: number,
): Promise<LookupWithDeadlineResult> => {
	if (timeoutMs <= 0) {
		return Promise.resolve({ kind: "timeout" })
	}
	return new Promise<LookupWithDeadlineResult>((resolve) => {
		let settled = false
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true
				resolve({ kind: "timeout" })
			}
		}, timeoutMs)
		void lookupAll(hostname).then(
			(addresses) => {
				clearTimeout(timer)
				if (!settled) {
					settled = true
					resolve({ kind: "ok", addresses })
				}
			},
			(error: unknown) => {
				clearTimeout(timer)
				if (!settled) {
					settled = true
					resolve({
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					})
				}
			},
		)
	})
}

interface SingleAttemptOutcome {
	readonly result: WebhookHttpResult
	readonly retryableConnectError: boolean
}

const attemptPublicHttpsRequest = (input: {
	readonly requestFn: typeof https.request
	readonly parsed: URL
	readonly hostname: string
	readonly ipFamily: number
	readonly port: number
	readonly outboundHeaders: http.OutgoingHttpHeaders
	readonly body: Buffer
	readonly candidates: ReadonlyArray<LookupAddress>
	readonly remainingMs: number
}): Promise<SingleAttemptOutcome> => {
	const [primary] = input.candidates
	if (primary === undefined || input.remainingMs <= 0) {
		return Promise.resolve({ result: { kind: "timeout" }, retryableConnectError: false })
	}
	return new Promise<SingleAttemptOutcome>((resolve) => {
		let settled = false
		let secured = false
		const finish = (outcome: SingleAttemptOutcome) => {
			if (!settled) {
				settled = true
				clearTimeout(deadlineTimer)
				resolve(outcome)
			}
		}

		const req = input.requestFn(
			{
				protocol: "https:",
				hostname: input.hostname,
				port: input.port,
				path: `${input.parsed.pathname}${input.parsed.search}`,
				method: "POST",
				headers: input.outboundHeaders,
				agent: false,
				...(input.ipFamily === 0 ? { servername: input.hostname } : {}),
				rejectUnauthorized: true,
				lookup: (_hostname, options, callback) => {
					if (typeof options === "object" && options !== null && options.all === true) {
						callback(
							null,
							input.candidates.map((entry) => ({ address: entry.address, family: entry.family })),
						)
						return
					}
					callback(null, primary.address, primary.family)
				},
			},
			(res) => {
				const status = res.statusCode ?? 502
				res.resume()
				res.destroy()
				finish({ result: { kind: "response", status }, retryableConnectError: false })
			},
		)

		const deadlineTimer = setTimeout(() => {
			req.destroy()
			finish({ result: { kind: "timeout" }, retryableConnectError: false })
		}, input.remainingMs)

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
			socket.once("secureConnect", () => {
				verifyPeerAddress()
				if (!socket.destroyed) {
					secured = true
				}
			})
		})

		req.on("error", (error) => {
			if (error instanceof BlockedDestinationError) {
				finish({
					result: { kind: "invalid_destination", message: error.message },
					retryableConnectError: false,
				})
				return
			}
			finish({
				result: {
					kind: "network_error",
					message: error instanceof Error ? error.message : String(error),
				},
				retryableConnectError: !secured,
			})
		})

		req.end(input.body)
	})
}

/**
 * Executes a single outbound HTTPS webhook POST while enforcing public-only
 * destinations at actual connection time under a single end-to-end deadline:
 * 1. Validates and canonicalizes the HTTPS destination URL.
 * 2. Resolves DNS within the end-to-end deadline and verifies EVERY returned
 *    A/AAAA record is publicly routable.
 * 3. Supplies all verified public addresses for family selection / fallback
 *    while preserving the original hostname for TLS SNI and cert verification.
 * 4. Re-verifies `socket.remoteAddress` upon TCP/TLS connect before writing bytes.
 * 5. Never follows HTTP redirects and aborts in-flight work when the deadline expires.
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
	const deadlineAt = Date.now() + Math.max(1, input.timeoutMs)
	const remainingMs = () => deadlineAt - Date.now()

	const parsed = new URL(canonical)
	const hostname =
		parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
			? parsed.hostname.slice(1, -1)
			: parsed.hostname
	const ipFamily = net.isIP(hostname)
	const port = parsed.port.length > 0 ? Number(parsed.port) : 443
	const lookupAll = input.lookupAll ?? defaultLookupAll
	const requestFn = input.httpsRequest ?? https.request

	// Resolve and validate every IP upfront within the end-to-end deadline.
	let addresses: ReadonlyArray<LookupAddress>
	if (ipFamily !== 0) {
		addresses = [{ address: hostname, family: ipFamily }]
	} else {
		const resolved = await lookupWithinDeadline(lookupAll, hostname, remainingMs())
		if (resolved.kind === "timeout") {
			return { kind: "timeout" }
		}
		if (resolved.kind === "error") {
			return { kind: "network_error", message: `DNS resolution failed: ${resolved.message}` }
		}
		addresses = resolved.addresses
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

	let lastResult: WebhookHttpResult = {
		kind: "network_error",
		message: "Unable to connect to any verified webhook address.",
	}
	for (let index = 0; index < addresses.length; index++) {
		const left = remainingMs()
		if (left <= 0) {
			return { kind: "timeout" }
		}
		const attempt = await attemptPublicHttpsRequest({
			requestFn,
			parsed,
			hostname,
			ipFamily,
			port,
			outboundHeaders,
			body: input.body,
			candidates: addresses.slice(index),
			remainingMs: left,
		})
		lastResult = attempt.result
		if (!attempt.retryableConnectError) {
			return attempt.result
		}
	}
	return lastResult
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
