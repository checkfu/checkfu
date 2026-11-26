import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { ClientEventId } from "../src/Api.ts"
import { CheckfuFetchError, createFetchClient, operationUrl } from "../src/Fetch.ts"
import type {
	FetchInput,
	FetchInputArgs,
	JsonOperationId,
	OperationId,
	UrlInput,
	UrlInputArgs,
} from "../src/Fetch.ts"
import { SDK_OPERATION_BINDINGS } from "../src/generated/OperationBindings.ts"
import { isClientEventId } from "../src/IdempotencyKey.ts"

interface Sent {
	readonly url: string
	readonly method: string | undefined
	readonly mode: RequestMode | undefined
	readonly headers: Headers
	readonly body: string | null
}

const recording = (status: number, body: string) => {
	const sent: Array<Sent> = []
	const fetch: typeof globalThis.fetch = async (url, init) => {
		sent.push({
			url: String(url),
			method: init?.method,
			mode: init?.mode,
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : null,
		})
		return new Response(body, { status })
	}
	return { sent, fetch }
}

type Requirement<T, K extends PropertyKey> = K extends keyof T
	? [Exclude<T[K], undefined>] extends [never]
		? "absent"
		: Record<never, never> extends Pick<T, K>
			? "optional"
			: "required"
	: "absent"

interface NonScalarQueryInput {
	readonly query: Readonly<Record<string, { readonly by: string }>>
}

interface SignalUrlInput {
	readonly path: { readonly agent_id: string }
	readonly signal: AbortSignal
}

interface LoosePathInput {
	readonly path: Readonly<Record<string, string | null | { readonly id: string }>>
}

type Assignable<A, B> = [A] extends [B] ? true : false

interface LooseInput {
	readonly path?: Readonly<Record<string, string>>
	readonly body?: { readonly name: string }
	readonly idempotencyKey?: string
	readonly query?: Readonly<Record<string, string | null>>
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
			"sessions.retrieve takes no path parameter sesion_id.",
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

		expect(() => createFetchClient({ fetch, headers: { "Idempotency-Key": "shared" } })).toThrow(
			"An idempotency key identifies one request",
		)
	})

	it("sends an idempotency key exactly as given, refusing one the API would reject", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		const request = createFetchClient({ fetch })
		const body = { name: "Helper", model: "claude-opus-5-5" }
		for (const idempotencyKey of ["job ", " job", "", "k".repeat(129)]) {
			await expect(request("agents.create", { body, idempotencyKey })).rejects.toThrow(
				"Invalid idempotencyKey: must be 1 to 128 characters with no leading or trailing whitespace.",
			)
		}
		expect(sent).toEqual([])
		await request("agents.create", { body, idempotencyKey: "k".repeat(128) })
		expect(sent.map((call) => call.headers.get("idempotency-key"))).toEqual(["k".repeat(128)])
	})

	it("refuses an idempotency key on an operation that does not deduplicate by one", async () => {
		const { sent, fetch } = recording(202, JSON.stringify({ run: 1 }))
		const request = untyped(createFetchClient({ fetch }))
		const input: LooseInput = { path: { automation_id: "auto_1" }, idempotencyKey: "run-once" }
		await expect(request("automations.run", input)).rejects.toThrow(
			"automations.run takes no idempotency key",
		)
		expect(sent).toEqual([])
	})

	it("uses the headers it was created with, even if the caller's object changes later", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		const shared = new Headers({ "x-trace": "dashboard" })
		const request = createFetchClient({ fetch, headers: shared })
		shared.set("idempotency-key", "added-later")
		shared.set("x-trace", "changed")
		const body = { name: "Helper", model: "claude-opus-5-5" }
		await request("agents.create", { body })
		await request("agents.create", { body })
		expect(
			sent.map((call) => [call.headers.get("idempotency-key"), call.headers.get("x-trace")]),
		).toEqual([
			[null, "dashboard"],
			[null, "dashboard"],
		])
	})

	it("checks an idempotency key by the same rule as the API's ClientEventId", () => {
		const is = Schema.is(ClientEventId)
		for (const key of [
			"a",
			"job 1",
			"job ",
			" job",
			"\tjob",
			"job\n",
			"",
			"k".repeat(128),
			"k".repeat(129),
			"\u00a0job",
			"\u3000job",
		]) {
			expect([key, isClientEventId(key)]).toEqual([key, is(key)])
		}
	})

	it("takes only a single operation id, so its input always matches that operation", () => {
		expectTypeOf<FetchInputArgs<"agents.list" | "agents.create">>().toEqualTypeOf<[input: never]>()
		expectTypeOf<UrlInputArgs<"agents.list" | "sessions.events.stream">>().toEqualTypeOf<
			[input: never]
		>()
		expectTypeOf<
			Requirement<FetchInputArgs<"agents.create">[0], "body">
		>().toEqualTypeOf<"required">()
	})

	it("does not accept a field the operation does not declare, from a literal or a variable", () => {
		const retrieveWithBody = { path: { agent_id: "a" }, body: { version: 1, name: "x" } }
		const createWithQuery = { query: { order: "desc" as const } }
		const runWithKey = { path: { automation_id: "auto_1" }, idempotencyKey: "run-once" }
		const urlWithBody = { path: { agent_id: "a" }, body: { name: "x" } }
		expectTypeOf<
			Assignable<typeof retrieveWithBody, FetchInput<"agents.retrieve">>
		>().toEqualTypeOf<false>()
		expectTypeOf<
			Assignable<typeof createWithQuery, UrlInput<"agents.create">>
		>().toEqualTypeOf<false>()
		expectTypeOf<
			Assignable<typeof runWithKey, FetchInput<"automations.run">>
		>().toEqualTypeOf<false>()
		expectTypeOf<
			Assignable<typeof urlWithBody, UrlInput<"agents.retrieve">>
		>().toEqualTypeOf<false>()
		expectTypeOf<
			Assignable<{ readonly path: { readonly agent_id: string } }, FetchInput<"agents.retrieve">>
		>().toEqualTypeOf<true>()
		expectTypeOf<
			Assignable<{ readonly query: { readonly order: "desc" } }, UrlInput<"agents.list">>
		>().toEqualTypeOf<true>()
	})

	it("refuses an undeclared body or query parameter at run time too, before sending", async () => {
		const { sent, fetch } = recording(200, "{}")
		const request = untyped(createFetchClient({ fetch }))
		await expect(
			request("agents.retrieve", { path: { agent_id: "a" }, body: { name: "x" } }),
		).rejects.toThrow("agents.retrieve takes no body.")
		const loose = operationUrl as (operationId: string, input: LooseInput) => string
		expect(() => loose("agents.create", { query: { order: "desc" } })).toThrow(
			"agents.create takes no query parameter order.",
		)
		expect(() => loose("agents.list", { query: { order: "desc", sort: "name" } })).toThrow(
			"agents.list takes no query parameter sort.",
		)
		expect(sent).toEqual([])
	})

	it("refuses a path parameter the operation does not take, so a mutation never widens its scope", async () => {
		const { sent, fetch } = recording(
			200,
			JSON.stringify({ id: "art_1", type: "artifact_deleted" }),
		)
		const versioned = { artifact_id: "art_1", version: 2 }
		await expect(
			createFetchClient({ fetch })("artifacts.delete", { path: versioned }),
		).rejects.toThrow("artifacts.delete takes no path parameter version.")
		expect(sent).toEqual([])
	})

	it("refuses a missing or null required query parameter in both the client and the URL builder", async () => {
		expect(
			SDK_OPERATION_BINDINGS.filter((binding) => binding.requiredQueryParams.length > 0).map(
				(binding) => [binding.operationId, binding.requiredQueryParams],
			),
		).toEqual([["artifacts.versions.file", ["file"]]])
		const loose = operationUrl as (operationId: string, input: LooseInput) => string
		const path = { artifact_id: "art_1", version: "1" }
		expect(() => loose("artifacts.versions.file", { path })).toThrow(
			"Missing file for artifacts.versions.file.",
		)
		const { sent, fetch } = recording(200, "{}")
		await expect(
			untyped(createFetchClient({ fetch }))("artifacts.versions.file", {
				path,
				query: { file: null },
			}),
		).rejects.toThrow("Missing file for artifacts.versions.file.")
		expect(sent).toEqual([])
		expect(loose("artifacts.versions.file", { path, query: { file: "index.html" } })).toBe(
			"/v1/artifacts/art_1/versions/1/file?file=index.html",
		)
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
		const { sent, fetch } = recording(
			200,
			JSON.stringify({ id: "art_1", type: "artifact_deleted" }),
		)
		await createFetchClient({ fetch })("artifacts.delete", { path: { artifact_id: "art_1" } })
		expect([
			sent[0]?.method,
			sent[0]?.url,
			sent[0]?.body,
			sent[0]?.headers.has("content-type"),
		]).toEqual(["DELETE", "/v1/artifacts/art_1", null, false])
	})

	it("refuses the event stream at run time too, without sending a request", async () => {
		const { sent, fetch } = recording(200, "event: message\ndata: {}\n\n")
		await expect(
			untyped(createFetchClient({ fetch }))("sessions.events.stream", {
				path: { session_id: "sess_1" },
			}),
		).rejects.toThrow('open operationUrl("sessions.events.stream") with an EventSource')
		expect(sent).toEqual([])
	})

	it("refuses an empty reply from an operation that promises JSON", async () => {
		const { fetch } = recording(200, "")
		await expect(
			createFetchClient({ fetch })("artifacts.delete", { path: { artifact_id: "art_1" } }),
		).rejects.toThrow("artifacts.delete answered 200 with an empty body.")
	})

	it("keeps a partial batch's outcome on the error, so a caller knows what was committed", async () => {
		const accepted = [{ id: "evt_1", type: "user.message" }]
		const { fetch } = recording(
			500,
			JSON.stringify({
				type: "error",
				error: { type: "api_error", message: "The second event was not confirmed." },
				request_id: "req_1",
				accepted,
				unconfirmed_index: 1,
			}),
		)
		const failure = await untyped(createFetchClient({ fetch }))("sessions.events.send", {
			path: { session_id: "sess_1" },
			body: { name: "x" },
		}).catch((error: unknown) => error)
		expect(failure).toMatchObject({
			status: 500,
			type: "api_error",
			requestId: "req_1",
			accepted,
			failedIndex: undefined,
			unconfirmedIndex: 1,
		})
		const refused = recording(
			400,
			JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "Event 2 is invalid." },
				request_id: "req_2",
				accepted,
				failed_index: 1,
			}),
		)
		await expect(
			untyped(createFetchClient({ fetch: refused.fetch }))("sessions.events.send", {
				path: { session_id: "sess_1" },
				body: { name: "x" },
			}),
		).rejects.toMatchObject({ accepted, failedIndex: 1, unconfirmedIndex: undefined })
	})

	it("validates and sends the same query values, read once from each declared field", () => {
		class FileQuery {
			get file(): string {
				return "index.html"
			}
		}
		const path = { artifact_id: "art_1", version: 1 }
		expect(operationUrl("artifacts.versions.file", { path, query: new FileQuery() })).toBe(
			"/v1/artifacts/art_1/versions/1/file?file=index.html",
		)
		const loose = operationUrl as (operationId: string, input: NonScalarQueryInput) => string
		expect(() => loose("agents.list", { query: { order: { by: "name" } } })).toThrow(
			"Invalid order: must be a string, number or boolean.",
		)
	})

	it("refuses a null or non-scalar path value instead of sending its string form", async () => {
		const { sent, fetch } = recording(200, "{}")
		const request = untyped(createFetchClient({ fetch })) as unknown as (
			operationId: string,
			input: LoosePathInput,
		) => Promise<void>
		await expect(request("artifacts.delete", { path: { artifact_id: null } })).rejects.toThrow(
			"Missing artifact_id for artifacts.delete.",
		)
		await expect(
			request("artifacts.delete", { path: { artifact_id: { id: "art_1" } } }),
		).rejects.toThrow("Invalid artifact_id: must be a string or a number.")
		expect(sent).toEqual([])
	})

	it("asks fetch for same-origin delivery, so a base URL or redirect elsewhere fails instead", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		await createFetchClient({ fetch })("agents.create", {
			body: { name: "Helper", model: "claude-opus-5-5" },
			idempotencyKey: "create-helper",
		})
		expect(sent.map((call) => call.mode)).toEqual(["same-origin"])
	})

	it("refuses an option it does not know, so a misspelled idempotency key is never dropped silently", async () => {
		const { sent, fetch } = recording(201, JSON.stringify({ id: "agent_1", type: "agent" }))
		const misspelled = {
			body: { name: "Helper", model: "claude-opus-5-5" },
			idempotency_key: "create-helper",
		}
		await expect(createFetchClient({ fetch })("agents.create", misspelled)).rejects.toThrow(
			"agents.create takes no option idempotency_key.",
		)
		const withSignal = { path: { agent_id: "a" }, signal: new AbortController().signal }
		expect(() =>
			(operationUrl as (operationId: string, input: SignalUrlInput) => string)(
				"agents.retrieve",
				withSignal,
			),
		).toThrow("agents.retrieve takes no option signal.")
		expect(sent).toEqual([])
	})

	it("takes the request id from the response headers when the error body cannot be read", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response("<html>Bad gateway</html>", { status: 502, headers: { "request-id": "req_9" } })
		await expect(
			createFetchClient({ fetch })("agents.retrieve", { path: { agent_id: "agent_1" } }),
		).rejects.toMatchObject({ status: 502, requestId: "req_9" })
	})

	it("keeps the status when an error reply's body cannot be read", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(
				new ReadableStream({
					start: (controller) => controller.error(new Error("connection reset")),
				}),
				{ status: 401 },
			)
		await expect(
			createFetchClient({ fetch })("agents.retrieve", { path: { agent_id: "agent_1" } }),
		).rejects.toMatchObject({
			status: 401,
			type: null,
			message: "Request failed with status 401.",
		})
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
			const query = Object.fromEntries(binding.requiredQueryParams.map((name) => [name, "x"]))
			const url = (operationUrl as (operationId: string, input: LooseInput) => string)(
				binding.operationId,
				{ path, query },
			)
			expect([binding.operationId, url.includes("{")]).toEqual([binding.operationId, false])
		}
	})
})
