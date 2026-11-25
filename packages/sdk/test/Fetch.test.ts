import { describe, expect, it } from "@effect/vitest"
import { CheckfuFetchError, createFetchClient, operationUrl } from "../src/Fetch.ts"
import { SDK_OPERATION_BINDINGS } from "../src/generated/OperationBindings.ts"

interface Sent {
	readonly url: string
	readonly method: string | undefined
	readonly headers: Headers
	readonly body: string | null
}

const recording = (status: number, body: string) => {
	const sent: Array<Sent> = []
	const fetch: typeof globalThis.fetch = async (url, init) => {
		sent.push({
			url: String(url),
			method: init?.method,
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : null,
		})
		return new Response(body, { status })
	}
	return { sent, fetch }
}

describe("the fetch client", () => {
	it("fills the operation's path from its parameters, encoding each one, and adds the query it was given", () => {
		expect(
			operationUrl(
				"automations.runs.retrieve",
				{ automation_id: "auto/1 2", run: 7 },
				{ after: undefined, order: "desc" },
			),
		).toBe("/v1/automations/auto%2F1%202/runs/7?order=desc")
		expect(operationUrl("sessions.events.stream", { session_id: "sess_1" }, { after: 0 })).toBe(
			"/v1/sessions/sess_1/events/stream?after=0",
		)
	})

	it("sends the operation's method, a JSON body and the idempotency key, and returns the parsed reply", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		const request = createFetchClient({ fetch, baseUrl: "https://api.test" })
		const created = await request("agents.create", {
			body: { name: "Helper", model: "claude-opus-5-5" },
			idempotencyKey: "create-helper",
		})
		expect(created).toEqual({ id: "agent_1", type: "agent" })
		expect(sent.map((call) => [call.method, call.url, call.body])).toEqual([
			[
				"POST",
				"https://api.test/v1/agents",
				JSON.stringify({ name: "Helper", model: "claude-opus-5-5" }),
			],
		])
		expect(sent[0]?.headers.get("idempotency-key")).toBe("create-helper")
		expect(sent[0]?.headers.get("content-type")).toBe("application/json")
	})

	it("sends no body or content type on a request without one", async () => {
		const { sent, fetch } = recording(200, "")
		await createFetchClient({ fetch })("artifacts.delete", { path: { artifact_id: "art_1" } })
		expect([
			sent[0]?.method,
			sent[0]?.url,
			sent[0]?.body,
			sent[0]?.headers.has("content-type"),
		]).toEqual(["DELETE", "/v1/artifacts/art_1", null, false])
	})

	it("raises the API's error type and message with the status, and a fallback when the reply is not an API error", async () => {
		const refused = recording(
			404,
			JSON.stringify({
				type: "error",
				error: { type: "not_found_error", message: "Agent agent_9 not found." },
			}),
		)
		const failure = await createFetchClient({ fetch: refused.fetch })("agents.retrieve", {
			path: { agent_id: "agent_9" },
		}).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(CheckfuFetchError)
		expect(failure).toMatchObject({
			status: 404,
			type: "not_found_error",
			message: "Agent agent_9 not found.",
		})

		const broken = recording(502, "<html>Bad gateway</html>")
		const gateway = await createFetchClient({ fetch: broken.fetch })("agents.retrieve", {
			path: { agent_id: "agent_1" },
		}).catch((error: unknown) => error)
		expect(gateway).toMatchObject({
			status: 502,
			type: null,
			message: "Request failed with status 502.",
		})
	})

	it("knows every operation the SDK generates", () => {
		for (const binding of SDK_OPERATION_BINDINGS) {
			expect(operationUrl(binding.operationId as never).startsWith("/v1/")).toBe(true)
		}
	})
})
