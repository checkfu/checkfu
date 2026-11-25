import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import * as Redacted from "effect/Redacted"
import { createNoRedirectProviderFetch, createPiModels } from "../src/Pi/PiModels.ts"

const listen = async (status: number, headers: Readonly<Record<string, string>>) => {
	let hits = 0
	const server = createServer((_request, response) => {
		hits += 1
		response.writeHead(status, headers).end()
	})
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const { port } = server.address() as AddressInfo
	return {
		origin: `http://127.0.0.1:${port}`,
		hits: () => hits,
		close: () => server.close(),
	}
}

describe("provider redirect", () => {
	it("is never followed by the OpenAI or Anthropic provider", async () => {
		const target = await listen(200, { "content-type": "text/plain" })
		const redirector = await listen(302, { location: `${target.origin}/steal` })
		try {
			const models = createPiModels({
				openai: Redacted.make("sk-openai-test"),
				anthropic: Redacted.make("sk-ant-test"),
			})
			for (const [provider, modelId, baseUrl] of [
				["openai", "gpt-4o-mini", `${redirector.origin}/v1`],
				["anthropic", "claude-sonnet-4-5", redirector.origin],
			] as const) {
				const model = models.getModel(provider, modelId)
				if (model === undefined) {
					throw new Error(`No model ${provider}/${modelId}`)
				}
				const before = redirector.hits()
				const result = await models.completeSimple(
					{ ...model, baseUrl },
					{ messages: [{ role: "user", content: "secret transcript", timestamp: 0 }] },
					{ maxRetries: 0 },
				)
				expect([provider, result.stopReason]).toEqual([provider, "error"])
				expect(redirector.hits()).toBeGreaterThan(before)
				expect(target.hits()).toBe(0)
			}
		} finally {
			redirector.close()
			target.close()
		}
	})

	it("asks the transport for manual redirects and refuses every 3xx answer", async () => {
		const seen: Array<{ readonly input: unknown; readonly init: RequestInit | undefined }> = []
		let cancelled = 0
		const answering =
			(status: number): typeof fetch =>
			(input, init) => {
				seen.push({ input, init })
				return Promise.resolve(
					new Response(
						new ReadableStream({
							cancel: () => {
								cancelled += 1
							},
						}),
						{ status },
					),
				)
			}

		const url = new URL("https://api.openai.com/v1/responses")
		const init = { method: "POST", body: "{}", redirect: "follow", keepalive: false } as const
		const answered = await createNoRedirectProviderFetch(answering(404))(url, init)
		expect(answered.status).toBe(404)
		expect(seen).toEqual([{ input: url, init: { ...init, redirect: "manual" } }])
		expect(seen[0]?.input).toBe(url)
		expect(init.redirect).toBe("follow")
		expect(cancelled).toBe(0)

		for (const status of [300, 301, 302, 303, 307, 308, 399]) {
			const before = cancelled
			await expect(
				createNoRedirectProviderFetch(answering(status))("https://api.openai.com/v1/responses"),
			).rejects.toThrow(/redirect/)
			expect([status, cancelled]).toEqual([status, before + 1])
		}
		expect(seen.at(-1)?.init).toEqual({ redirect: "manual" })

		const globalFetch = globalThis.fetch
		const guarded = createNoRedirectProviderFetch()
		globalThis.fetch = answering(200)
		try {
			expect((await guarded("https://api.openai.com/v1/responses")).status).toBe(200)
		} finally {
			globalThis.fetch = globalFetch
		}
	})
})
