import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { CheckfuFetchError, createFetchClient, operationUrl } from "../src/Fetch.ts"
import type { FetchInput, JsonOperationId, OperationId, UrlInput } from "../src/Fetch.ts"
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

type Requirement<T, K extends PropertyKey> = K extends keyof T
	? Record<never, never> extends Pick<T, K>
		? "optional"
		: "required"
	: "absent"

interface LooseInput {
	readonly path?: Readonly<Record<string, string>>
	readonly body?: { readonly name: string }
}

const untyped = (request: ReturnType<typeof createFetchClient>) =>
	request as unknown as (operationId: string, input?: LooseInput) => Promise<void>

describe("the fetch client", () => {
	it("addresses the API on the page's own origin, filling and encoding each path parameter", () => {
		expect(
			operationUrl("automations.runs.retrieve", {
				path: { automation_id: "auto 1", run: 7 },
			}),
		).toBe("/v1/automations/auto%201/runs/7")
		expect(
			operationUrl("sessions.events.stream", {
				path: { session_id: "sess_1" },
				query: { after: 0 },
			}),
		).toBe("/v1/sessions/sess_1/events/stream?after=0")
		expect(operationUrl("agents.list", { query: { order: "desc", after: undefined } })).toBe(
			"/v1/agents?order=desc",
		)
	})

	it("refuses an empty, dot or multi-segment resource id before sending anything", async () => {
		const { sent, fetch } = recording(200, "{}")
		const request = createFetchClient({ fetch })
		for (const agent_id of ["", ".", "..", "a/b", String.raw`a\b`]) {
			await expect(request("agents.retrieve", { path: { agent_id } })).rejects.toThrow(
				"Invalid agent_id: must be a single non-empty path segment",
			)
		}
		expect(sent).toEqual([])
	})

	it("refuses a missing or misspelled path parameter instead of leaving a placeholder in the URL", async () => {
		const { sent, fetch } = recording(200, "{}")
		const request = untyped(createFetchClient({ fetch }))
		await expect(request("sessions.retrieve")).rejects.toThrow("Missing session_id")
		await expect(request("sessions.retrieve", { path: { sesion_id: "sess_1" } })).rejects.toThrow(
			"Missing session_id",
		)
		expect(sent).toEqual([])
	})

	it("requires an idempotency key where the API does, and a body wherever the API requires one", async () => {
		expectTypeOf<
			Requirement<FetchInput<"automations.create">, "idempotencyKey">
		>().toEqualTypeOf<"required">()
		expectTypeOf<
			Requirement<FetchInput<"agents.create">, "idempotencyKey">
		>().toEqualTypeOf<"optional">()
		expectTypeOf<
			Requirement<FetchInput<"agents.retrieve">, "idempotencyKey">
		>().toEqualTypeOf<"absent">()
		expectTypeOf<Requirement<FetchInput<"artifacts.publish">, "body">>().toEqualTypeOf<"required">()
		expectTypeOf<
			Requirement<FetchInput<"artifacts.versions.link">, "body">
		>().toEqualTypeOf<"required">()
		expectTypeOf<Requirement<FetchInput<"agents.archive">, "body">>().toEqualTypeOf<"absent">()
		expectTypeOf<
			Requirement<UrlInput<"sessions.events.stream">, "path">
		>().toEqualTypeOf<"required">()

		const { sent, fetch } = recording(200, "{}")
		const request = untyped(createFetchClient({ fetch }))
		await expect(request("automations.create", { body: { name: "x" } })).rejects.toThrow(
			"automations.create needs an idempotency key.",
		)
		await expect(request("artifacts.publish", { path: { artifact_id: "art_1" } })).rejects.toThrow(
			"artifacts.publish needs a body.",
		)
		expect(sent).toEqual([])

		await untyped(createFetchClient({ fetch, headers: { "idempotency-key": "from-defaults" } }))(
			"automations.create",
			{ body: { name: "x" } },
		)
		expect(sent.map((call) => call.headers.get("idempotency-key"))).toEqual(["from-defaults"])
	})

	it("offers the event stream only as a URL, since its reply is not JSON", () => {
		expectTypeOf<
			"sessions.events.stream" extends JsonOperationId ? true : false
		>().toEqualTypeOf<false>()
		expectTypeOf<
			"sessions.events.stream" extends OperationId ? true : false
		>().toEqualTypeOf<true>()
		expect(
			SDK_OPERATION_BINDINGS.filter((binding) => binding.kind === "sse").map(
				(binding) => binding.operationId,
			),
		).toEqual(["sessions.events.stream"])
	})

	it("sends the operation's method, a JSON body and the idempotency key, and returns the parsed reply", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		const created = await createFetchClient({ fetch })("agents.create", {
			body: { name: "Helper", model: "claude-opus-5-5" },
			idempotencyKey: "create-helper",
		})
		expect(created).toEqual({ id: "agent_1", type: "agent" })
		expect(sent.map((call) => [call.method, call.url, call.body])).toEqual([
			["POST", "/v1/agents", JSON.stringify({ name: "Helper", model: "claude-opus-5-5" })],
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

	it("fills every placeholder of every generated operation from its listed path parameters", () => {
		for (const binding of SDK_OPERATION_BINDINGS) {
			const path = Object.fromEntries(binding.pathParams.map((name) => [name, "x"]))
			const url = (operationUrl as (operationId: string, input: LooseInput) => string)(
				binding.operationId,
				{ path },
			)
			expect([binding.operationId, url.includes("{")]).toEqual([binding.operationId, false])
		}
	})
})
