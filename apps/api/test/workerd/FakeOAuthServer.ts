import { createServer } from "node:http"
import type { Socket } from "node:net"

export interface RecordedTokenRequest {
	readonly form: Readonly<Record<string, string>>
	readonly authorization: string | undefined
}

export interface FakeOAuthServer {
	readonly tokenEndpoint: string
	/** Every request the token endpoint received, in order. */
	readonly requests: ReadonlyArray<RecordedTokenRequest>
	/** Every access token and refresh token the server issued. */
	readonly issued: ReadonlyArray<string>
	/** Makes `refreshToken` the one refresh token the server accepts. */
	readonly grant: (refreshToken: string) => void
	/** Answers the next `times` requests with this failure, then goes back to issuing tokens. */
	readonly fail: (failure: "invalid_grant" | "server_error", times: number) => void
	/** Holds every answer this long, so requests made together overlap. */
	readonly delay: (ms: number) => void
	/** Called with each new access token before it is returned. */
	readonly onIssue: (listener: (accessToken: string) => void) => void
	readonly close: () => Promise<void>
}

/**
 * An OAuth token endpoint that rotates refresh tokens: each works once, and a
 * spent one is refused with `invalid_grant`.
 */
export const startFakeOAuthServer = async (): Promise<FakeOAuthServer> => {
	const requests: Array<RecordedTokenRequest> = []
	const issued: Array<string> = []
	const sockets = new Set<Socket>()
	let valid: string | undefined
	let count = 0
	let failure: { kind: "invalid_grant" | "server_error"; left: number } | undefined
	let delayMs = 0
	let listener: ((accessToken: string) => void) | undefined

	const http = createServer((request, response) => {
		const answer = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" })
			response.end(JSON.stringify(body))
		}
		void (async () => {
			const chunks: Array<Buffer> = []
			for await (const chunk of request) {
				chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer))
			}
			const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
			requests.push({ form, authorization: request.headers.authorization })
			if (delayMs > 0) {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, delayMs)
				})
			}
			if (failure !== undefined && failure.left > 0) {
				failure.left -= 1
				answer(failure.kind === "server_error" ? 500 : 400, { error: failure.kind })
				return
			}
			if (form["grant_type"] !== "refresh_token" || form["refresh_token"] !== valid) {
				answer(400, { error: "invalid_grant", error_description: "refresh token is spent" })
				return
			}
			count += 1
			const accessToken = `oat_fake_ISSUED_do_not_leak_${count}`
			valid = `ort_fake_ISSUED_do_not_leak_${count}`
			issued.push(accessToken, valid)
			listener?.(accessToken)
			answer(200, {
				access_token: accessToken,
				token_type: "Bearer",
				expires_in: 3600,
				refresh_token: valid,
			})
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
		throw new Error("fake OAuth server has no port")
	}
	return {
		tokenEndpoint: `http://127.0.0.1:${address.port}/oauth/token`,
		requests,
		issued,
		grant: (refreshToken) => {
			valid = refreshToken
		},
		fail: (kind, times) => {
			failure = { kind, left: times }
		},
		delay: (ms) => {
			delayMs = ms
		},
		onIssue: (next) => {
			listener = next
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
