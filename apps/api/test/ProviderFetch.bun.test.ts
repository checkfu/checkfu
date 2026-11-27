import { createServer } from "node:http"
import { expect, it } from "@effect/vitest"
import * as Redacted from "effect/Redacted"
import { createNoRedirectProviderFetch, createPiModels } from "../src/Pi/PiModels.ts"

it("refuses HTTP redirects and cross-origin requests at the provider fetch transport", async () => {
	let targetHits = 0
	const targetServer = createServer((_req, res) => {
		targetHits += 1
		res.writeHead(200, { "content-type": "text/plain" })
		res.end("SHOULD_NOT_BE_REACHED")
	})
	await new Promise<void>((resolve) => {
		targetServer.listen(0, "127.0.0.1", () => resolve())
	})
	const targetPort = (targetServer.address() as { port: number }).port

	let redirectorHits = 0
	const redirectorServer = createServer((_req, res) => {
		redirectorHits += 1
		res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` })
		res.end()
	})
	await new Promise<void>((resolve) => {
		redirectorServer.listen(0, "127.0.0.1", () => resolve())
	})
	const redirectorPort = (redirectorServer.address() as { port: number }).port

	try {
		const models = createPiModels(
			{
				openai: Redacted.make("sk-openai-test"),
				anthropic: Redacted.make("sk-ant-test"),
			},
			{
				openai: `http://127.0.0.1:${redirectorPort}/v1`,
				anthropic: `http://127.0.0.1:${redirectorPort}`,
			},
		)

		const openaiBase = models.getModel("openai", "gpt-4o-mini")
		if (openaiBase === undefined) {
			throw new Error("expected gpt-4o-mini")
		}
		const openaiStream = models.streamSimple(
			openaiBase,
			{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
			{ apiKey: "sk-openai-test", maxRetries: 0 },
		)
		const openaiResult = await openaiStream.result()
		expect(openaiResult.stopReason).toBe("error")
		expect(redirectorHits).toBeGreaterThanOrEqual(1)
		expect(targetHits).toBe(0)

		const hitsBeforeAnthropic = redirectorHits
		const anthropicBase = models.getModel("anthropic", "claude-sonnet-4-5")
		if (anthropicBase === undefined) {
			throw new Error("expected claude-sonnet-4-5")
		}
		const anthropicStream = models.streamSimple(
			anthropicBase,
			{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
			{ apiKey: "sk-ant-test", maxRetries: 0 },
		)
		const anthropicResult = await anthropicStream.result()
		expect(anthropicResult.stopReason).toBe("error")
		expect(redirectorHits).toBeGreaterThan(hitsBeforeAnthropic)
		expect(targetHits).toBe(0)

		const hitsBeforePinnedCheck = redirectorHits
		const prodModels = createPiModels({
			openai: Redacted.make("sk-openai-prod"),
			anthropic: Redacted.make("sk-ant-prod"),
		})
		const rejectedOpenAI = await prodModels
			.streamSimple(
				openaiBase,
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ maxRetries: 0 },
			)
			.result()
		expect(rejectedOpenAI.stopReason).toBe("error")
		expect(rejectedOpenAI.errorMessage).toMatch(/disallowed origin/i)
		const rejectedAnthropic = await prodModels
			.streamSimple(
				anthropicBase,
				{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
				{ maxRetries: 0 },
			)
			.result()
		expect(rejectedAnthropic.stopReason).toBe("error")
		expect(rejectedAnthropic.errorMessage).toMatch(/disallowed origin/i)
		expect(redirectorHits).toBe(hitsBeforePinnedCheck)
		const seenInits: Array<RequestInit | undefined> = []
		const mockRedirectFetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seenInits.push(init)
			return new Response(null, {
				status: 307,
				headers: { location: "https://api.anthropic.com/v1/messages" },
			})
		}) as typeof fetch
		const guardedFetch = createNoRedirectProviderFetch(
			"https://api.openai.com/v1",
			mockRedirectFetch,
		)
		await expect(
			guardedFetch("https://api.openai.com/v1/responses", { redirect: "follow" }),
		).rejects.toThrow(/redirect/i)
		expect(seenInits).toHaveLength(1)
		expect(seenInits[0]?.redirect).toBe("manual")

		await expect(guardedFetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
			/disallowed origin/i,
		)
		expect(seenInits).toHaveLength(1)

		const spoofedUrl = Object.assign(new URL("https://evil.example/steal"), {
			url: "https://api.openai.com/v1/responses",
		})
		await expect(guardedFetch(spoofedUrl)).rejects.toThrow(/disallowed origin/i)
		expect(seenInits).toHaveLength(1)

		let opaqueBodyCancelled = false
		const opaqueBody = new ReadableStream<Uint8Array>({
			cancel() {
				opaqueBodyCancelled = true
			},
		})
		const guardedOpaque = createNoRedirectProviderFetch("https://api.openai.com/v1", (async () => ({
			status: 0,
			redirected: false,
			type: "opaqueredirect",
			body: opaqueBody,
		})) as unknown as typeof fetch)
		await expect(guardedOpaque("https://api.openai.com/v1/responses")).rejects.toThrow(/redirect/i)
		expect(opaqueBodyCancelled).toBe(true)

		const guardedRedirectedFlag = createNoRedirectProviderFetch(
			"https://api.openai.com/v1",
			(async () => ({
				status: 200,
				redirected: true,
				type: "basic",
				body: null,
			})) as unknown as typeof fetch,
		)
		await expect(guardedRedirectedFlag("https://api.openai.com/v1/responses")).rejects.toThrow(
			/redirect/i,
		)

		const seenDispatches: Array<{
			readonly input: Parameters<typeof fetch>[0]
			readonly init: RequestInit | undefined
		}> = []
		const okFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seenDispatches.push({ input, init })
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		const guardedOkFetch = createNoRedirectProviderFetch("https://api.openai.com/v1", okFetch)

		const nativePost = new Request("https://api.openai.com/v1/responses", {
			method: "POST",
			body: "must-stay-unused",
		})
		await expect(guardedOkFetch(nativePost)).rejects.toThrow(/only URL strings and URL instances/i)
		expect(nativePost.bodyUsed).toBe(false)

		class SubclassedRequest extends Request {}
		await expect(
			guardedOkFetch(new SubclassedRequest("https://api.openai.com/v1/responses")),
		).rejects.toThrow(/only URL strings and URL instances/i)

		await expect(
			guardedOkFetch({
				href: "https://api.openai.com/v1/responses",
			} as unknown as Parameters<typeof fetch>[0]),
		).rejects.toThrow(/only URL strings and URL instances/i)
		expect(seenDispatches).toHaveLength(0)

		const allowedUrl = Object.assign(new URL("https://api.openai.com/v1/responses"), {
			url: "https://evil.example/override",
		})
		await guardedOkFetch(allowedUrl)
		expect(seenDispatches.map((entry) => entry.input)).toEqual([
			"https://api.openai.com/v1/responses",
		])

		let releaseGate!: () => void
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve
		})
		const asyncObservedTargets: Array<Parameters<typeof fetch>[0]> = []
		const guardedAsync = createNoRedirectProviderFetch(
			"https://api.openai.com/v1",
			async (input: Parameters<typeof fetch>[0]) => {
				await gate
				asyncObservedTargets.push(input)
				return new Response("ok", { status: 200 })
			},
		)
		const mutableUrl = new URL("https://api.openai.com/v1/responses")
		const inFlight = guardedAsync(mutableUrl)
		mutableUrl.hostname = "evil.example"
		releaseGate()
		await inFlight
		expect(asyncObservedTargets).toEqual(["https://api.openai.com/v1/responses"])

		let bodyGetterCalls = 0
		let headersGetterCalls = 0
		let proxyGetterCalls = 0
		const getterBackedInit: RequestInit = { method: "POST", keepalive: false, redirect: "follow" }
		Object.defineProperty(getterBackedInit, "body", {
			enumerable: true,
			configurable: true,
			get: () => {
				bodyGetterCalls += 1
				return JSON.stringify({ input: "from-lazy-getter" })
			},
		})
		Object.defineProperty(getterBackedInit, "headers", {
			enumerable: true,
			configurable: true,
			get: () => {
				headersGetterCalls += 1
				return { "x-provider-test": "lazy-getter" }
			},
		})
		Object.defineProperty(getterBackedInit, "proxy", {
			enumerable: true,
			configurable: true,
			get: () => {
				proxyGetterCalls += 1
				return "http://127.0.0.1:8081"
			},
		})
		await guardedOkFetch("https://api.openai.com/v1/responses", getterBackedInit)
		expect(bodyGetterCalls).toBe(1)
		expect(headersGetterCalls).toBe(1)
		expect(proxyGetterCalls).toBe(1)
		expect(getterBackedInit.redirect).toBe("follow")
		const lastInit = seenDispatches.at(-1)?.init
		expect(lastInit?.redirect).toBe("manual")
		expect(lastInit?.keepalive).toBe(false)
		expect(lastInit !== undefined && "proxy" in lastInit ? lastInit.proxy : undefined).toBe(
			"http://127.0.0.1:8081",
		)

		const protoPollutingInit: RequestInit = { method: "POST", redirect: "follow" }
		Object.defineProperty(protoPollutingInit, "__proto__", {
			value: {
				proxy: "http://evil.example:9999",
				headers: { authorization: "Bearer injected" },
			},
			enumerable: true,
			configurable: true,
		})
		await guardedOkFetch("https://api.openai.com/v1/responses", protoPollutingInit)
		const copiedProtoInit = seenDispatches.at(-1)?.init
		expect(copiedProtoInit).toBeDefined()
		expect(Object.getPrototypeOf(copiedProtoInit)).toBe(Object.prototype)
		expect(copiedProtoInit?.redirect).toBe("manual")
		expect(copiedProtoInit?.method).toBe("POST")
		expect(copiedProtoInit?.headers).toBeUndefined()
		expect(copiedProtoInit !== undefined && "proxy" in copiedProtoInit).toBe(false)

		const savedGlobalFetch = globalThis.fetch
		const lateBoundTargets: Array<Parameters<typeof fetch>[0]> = []
		try {
			const guardedDefault = createNoRedirectProviderFetch("https://api.openai.com/v1")
			globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
				lateBoundTargets.push(input)
				return new Response("ok", { status: 200 })
			}
			await guardedDefault("https://api.openai.com/v1/responses")
		} finally {
			globalThis.fetch = savedGlobalFetch
		}
		expect(lateBoundTargets).toEqual(["https://api.openai.com/v1/responses"])
	} finally {
		redirectorServer.close()
		targetServer.close()
	}
})

it.runIf("Bun" in globalThis)(
	"preserves Bun proxy routing and keepalive: false connection behavior in the redirect guard",
	async () => {
		const directReceived: Array<{
			readonly authorization: string | undefined
			readonly contentType: string | undefined
			readonly contentLength: string | undefined
			readonly transferEncoding: string | undefined
			readonly body: string
		}> = []
		const directServer = createServer((req, res) => {
			const chunks: Array<Buffer> = []
			req.on("data", (chunk: Buffer) => {
				chunks.push(chunk)
			})
			req.on("end", () => {
				directReceived.push({
					authorization: req.headers.authorization,
					contentType: req.headers["content-type"],
					contentLength: req.headers["content-length"],
					transferEncoding: req.headers["transfer-encoding"],
					body: Buffer.concat(chunks).toString("utf8"),
				})
				res.writeHead(200, { "content-type": "text/plain" })
				res.end("from-direct")
			})
		})
		let proxyHits = 0
		const proxyBodies: Array<string> = []
		let proxyRespondRedirect = false
		const proxyServer = createServer((req, res) => {
			proxyHits += 1
			const chunks: Array<Buffer> = []
			req.on("data", (chunk: Buffer) => {
				chunks.push(chunk)
			})
			req.on("end", () => {
				proxyBodies.push(Buffer.concat(chunks).toString("utf8"))
				if (proxyRespondRedirect) {
					res.writeHead(302, { location: "https://evil.example/steal" })
					res.end()
					return
				}
				res.writeHead(200, { "content-type": "text/plain" })
				res.end("from-configured-proxy")
			})
		})

		let noReuseConnections = 0
		const noReuseServer = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" })
			res.end("ok")
		})
		noReuseServer.on("connection", () => {
			noReuseConnections += 1
		})

		let reuseConnections = 0
		const reuseServer = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" })
			res.end("ok")
		})
		reuseServer.on("connection", () => {
			reuseConnections += 1
		})

		await Promise.all([
			new Promise<void>((resolve) => {
				directServer.listen(0, "127.0.0.1", () => resolve())
			}),
			new Promise<void>((resolve) => {
				proxyServer.listen(0, "127.0.0.1", () => resolve())
			}),
			new Promise<void>((resolve) => {
				noReuseServer.listen(0, "127.0.0.1", () => resolve())
			}),
			new Promise<void>((resolve) => {
				reuseServer.listen(0, "127.0.0.1", () => resolve())
			}),
		])

		const directPort = (directServer.address() as { port: number }).port
		const proxyPort = (proxyServer.address() as { port: number }).port
		const noReusePort = (noReuseServer.address() as { port: number }).port
		const reusePort = (reuseServer.address() as { port: number }).port

		try {
			const directBaseUrl = `http://127.0.0.1:${directPort}/v1`
			const guardedProxyFetch = createNoRedirectProviderFetch(directBaseUrl)

			const payload = JSON.stringify({ input: "via-bun-proxy" })
			const proxyInit: RequestInit = {
				method: "POST",
				headers: { "x-provider-test": "bun-proxy" },
				body: payload,
				redirect: "follow",
			}
			Object.defineProperty(proxyInit, "proxy", {
				value: `http://127.0.0.1:${proxyPort}`,
				enumerable: true,
				configurable: true,
			})
			const proxyResponse = await guardedProxyFetch(`${directBaseUrl}/responses`, proxyInit)
			expect(proxyResponse.status).toBe(200)
			expect(await proxyResponse.text()).toBe("from-configured-proxy")
			expect(proxyHits).toBe(1)
			expect(proxyBodies).toEqual([payload])
			expect(directReceived).toHaveLength(0)

			proxyRespondRedirect = true
			const proxyRedirectInit: RequestInit = { redirect: "follow" }
			Object.defineProperty(proxyRedirectInit, "proxy", {
				value: `http://127.0.0.1:${proxyPort}`,
				enumerable: true,
				configurable: true,
			})
			await expect(
				guardedProxyFetch(`${directBaseUrl}/responses`, proxyRedirectInit),
			).rejects.toThrow(/redirect/i)
			expect(proxyHits).toBe(2)
			expect(directReceived).toHaveLength(0)

			const protoProxyInit: RequestInit = { method: "POST", body: "direct-only" }
			Object.defineProperty(protoProxyInit, "__proto__", {
				value: {
					proxy: `http://127.0.0.1:${proxyPort}`,
					headers: { authorization: "Bearer injected" },
				},
				enumerable: true,
				configurable: true,
			})
			const protoRes = await guardedProxyFetch(`${directBaseUrl}/responses`, protoProxyInit)
			expect(protoRes.status).toBe(200)
			expect(await protoRes.text()).toBe("from-direct")
			expect(proxyHits).toBe(2)
			expect(directReceived).toHaveLength(1)
			expect(directReceived[0]?.authorization).toBeUndefined()
			expect(directReceived[0]?.body).toBe("direct-only")

			const noReuseBaseUrl = `http://127.0.0.1:${noReusePort}/v1`
			const guardedNoReuseFetch = createNoRedirectProviderFetch(noReuseBaseUrl)
			for (let call = 0; call < 2; call++) {
				const res = await guardedNoReuseFetch(`${noReuseBaseUrl}/responses`, {
					keepalive: false,
					redirect: "follow",
				})
				expect(res.status).toBe(200)
				expect(await res.text()).toBe("ok")
			}
			expect(noReuseConnections).toBe(2)

			const reuseBaseUrl = `http://127.0.0.1:${reusePort}/v1`
			const guardedReuseFetch = createNoRedirectProviderFetch(reuseBaseUrl)
			for (let call = 0; call < 2; call++) {
				const res = await guardedReuseFetch(`${reuseBaseUrl}/responses`)
				expect(res.status).toBe(200)
				expect(await res.text()).toBe("ok")
			}
			expect(reuseConnections).toBe(1)

			const fixedLengthRes = await guardedProxyFetch(`${directBaseUrl}/responses`, {
				method: "POST",
				body: "abcd",
			})
			expect(fixedLengthRes.status).toBe(200)
			expect(await fixedLengthRes.text()).toBe("from-direct")
			expect(directReceived.at(-1)).toMatchObject({
				contentLength: "4",
				transferEncoding: undefined,
				body: "abcd",
			})

			const emptyPostRes = await guardedProxyFetch(`${directBaseUrl}/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "",
			})
			expect(emptyPostRes.status).toBe(200)
			expect(await emptyPostRes.text()).toBe("from-direct")
			expect(directReceived.at(-1)).toMatchObject({
				contentType: "application/json",
				contentLength: "0",
				transferEncoding: undefined,
				body: "",
			})

			const uploadController = new AbortController()
			let streamCancelled = false
			const uploadStream = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new TextEncoder().encode("part"))
					uploadController.abort()
				},
				cancel() {
					streamCancelled = true
				},
			})
			await expect(
				guardedProxyFetch(`${directBaseUrl}/responses`, {
					method: "POST",
					body: uploadStream,
					signal: uploadController.signal,
				}),
			).rejects.toThrow()
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 40)
			})
			expect(streamCancelled).toBe(true)

			const countBeforeReject = directReceived.length
			const rejectedReq = new Request(`${directBaseUrl}/responses`, {
				method: "POST",
				body: "must-not-send",
			})
			await expect(guardedProxyFetch(rejectedReq)).rejects.toThrow(
				/only URL strings and URL instances/i,
			)
			expect(rejectedReq.bodyUsed).toBe(false)
			expect(directReceived).toHaveLength(countBeforeReject)
		} finally {
			directServer.close()
			proxyServer.close()
			noReuseServer.close()
			reuseServer.close()
		}
	},
)
