# `@checkfu/sdk`

```sh
npm install @checkfu/sdk
```

Requires Node.js 22.0.0 or later. The published package contains JavaScript and TypeScript declarations; it does not require Bun or a TypeScript runtime loader.

Effect-native TypeScript SDK for the Checkfu API, with a thin Promise / `AsyncIterable` client built on top of the same core.

Create an agent and an environment, then create a session that references both. Use `client.sessions.events` to send a `user.message` event, list the session's event history, or follow its live event stream.

- **Single-source contract:** shares `CheckfuApi` (`effect/http-api/HttpApi`) and Effect `Schema` definitions directly with the Checkfu API server.
- **Forge-generated resources:** resource classes (`EffectResources` / `PromiseResources`), `CheckfuOperations` (`Op<Id>` / `BodyOf` / `QueryOf` / `ResultOf`), and `SDK_OPERATION_BINDINGS` are generated directly from `openapi.json` via `@cloudflare/forge` in lockstep with the CLI.
- **Core clients:** use `effect` and standard Web APIs (`fetch`, `ReadableStream`, `AbortController`, WebCrypto).
- Resources include `agents`, `environments`, `sessions`, `automations`, and `artifacts`. Use `waitForPending` when a mutation returns a resource receipt with `pending: true` and you need the completed resource.

Use a model ID configured for your deployment in the examples below.

## Effect-native usage

```ts
import { CheckfuClient } from "@checkfu/sdk"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const program = Effect.gen(function* () {
	const client = yield* CheckfuClient

	const agent = yield* client.waitForPending(
		yield* client.agents.create({
			name: "Assistant",
			model: "your-model-id",
			system: "You are concise and helpful.",
		}),
	)

	const env = yield* client.waitForPending(
		yield* client.environments.create({ name: "default" }),
	)

	const session = yield* client.waitForPending(
		yield* client.sessions.create({
			agent: agent.id,
			environment_id: env.id,
		}),
	)

	yield* client.sessions.events.send(session.id, {
		events: [{ type: "user.message", content: [{ type: "text", text: "Hello Checkfu!" }] }],
	})

	yield* client.sessions.events.stream(session.id).pipe(
		Stream.takeUntil(
			(event) => event.type === "session.status_idle" || event.type === "session.status_terminated",
		),
		Stream.runForEach((event) =>
			event.type === "session.status_idle" && event.stop_reason.type === "requires_action"
				? Effect.log("Waiting for tool answers", event.stop_reason.event_ids, "at sequence", event.seq)
				: Effect.log(event.type),
		),
	)
}).pipe(
	Effect.catchTag("NotFoundError", (err) => Effect.logError(`Missing resource: ${err.message}`)),
	Effect.catchTag("RateLimitError", (err) => Effect.logWarning(`Rate limited (${err.requestId})`)),
)

await Effect.runPromise(
	program.pipe(
		Effect.provide(
			CheckfuClient.layerFetchFromEnv(),
			// Or configure explicitly:
			// CheckfuClient.layerFetch({ apiKey: "...", baseUrl: "http://localhost:1337" })
			// Or inject your own HttpClient + SecureRandom layers via CheckfuClient.layer(...)
		),
	),
)
```

### Auto-pagination and response metadata (Effect)

```ts
// Stream every historical event across cursor pages:
const events = yield* Stream.runCollect(
	client.sessions.events.listStream(session.id, { limit: 50, order: "asc" }),
)

// Access HTTP status, headers, and request-id:
const { data, status, requestId } = yield* client.agents.retrieve(agent.id, {
	withResponse: true,
})
```

## Promise / `AsyncIterable` usage

```ts
import Checkfu from "@checkfu/sdk"

const client = new Checkfu({
	// Reads CHECKFU_API_KEY and CHECKFU_BASE_URL by default
	apiKey: process.env.CHECKFU_API_KEY,
	baseUrl: "http://localhost:1337",
})

const agent = await client.waitForPending(
	await client.agents.create({ name: "Assistant", model: "your-model-id" }),
)
const env = await client.waitForPending(await client.environments.create({ name: "default" }))
const session = await client.waitForPending(
	await client.sessions.create({ agent: agent.id, environment_id: env.id }),
)

await client.sessions.events.send(session.id, {
	events: [{ type: "user.message", content: [{ type: "text", text: "Hello Checkfu!" }] }],
})

// Live SSE streaming (supports AbortController via stream.controller.abort(), stream.tee(), and stream.toReadableStream())
const stream = await client.sessions.events.stream(session.id)
for await (const event of stream) {
	if (event.type === "agent.message") {
		console.log(event.content.map((b) => b.text).join(""))
	}
	if (event.type === "session.status_terminated") {
		break
	}
	if (event.type === "session.status_idle") {
		if (event.stop_reason.type === "requires_action") {
			console.log("Waiting for tool answers", event.stop_reason.event_ids, "at sequence", event.seq)
		}
		break
	}
}

// Auto-paginating cursor iteration
for await (const event of client.sessions.events.list(session.id, { limit: 50 })) {
	console.log(event.seq, event.type)
}

// Raw response metadata (single underlying HTTP call)
const { data, status, request_id, requestId } = await client.agents
	.retrieve(agent.id)
	.withResponse()
```

Pass `agent: agent.id` when creating a session to pin the latest agent version. To pin a specific version, pass `agent: { type: "agent", id: agent.id, version: agent.version }`.

## Pausing and resuming a turn

Both examples return control when the stream reports an idle or terminated session. A `requires_action` stop leaves the turn paused, with `stop_reason.event_ids` identifying the tool calls that need answers. Read each tool call and send a `user.tool_confirmation` for an `agent.mcp_tool_use` or a `user.custom_tool_result` for an `agent.custom_tool_use`. Then call `sessions.events.stream(session.id, { after: pauseSequence })` with the paused event's `seq` to continue reading that turn.

Other idle stop reasons settle the turn, including an interrupt. A `session.error` event reports a failure or a retry, with details in `error.retry_status`. A terminal failure emits `session.status_terminated` and may leave the stream open. For an archived session the stream closes after any remaining events. If the cursor already covers those events, it closes immediately.

## Sending session events

`sessions.events.send` accepts up to 8 events in a single JSON request of at most 802,816 UTF-8 bytes. Measure the encoded body including the `events` wrapper, field names, and JSON escaping. Each user message accepts up to 16,384 UTF-16 code units after joining its text blocks with a newline.

If a batch exceeds the byte limit, combine adjacent text blocks using `blocks.map(({ text }) => text).join("\n")` to preserve the message text. An HTTP 413 accepts no events. To split a batch, keep the same event IDs for those events and send the batches in order. Give each distinct batch its own idempotency key and reuse that key when retrying the same batch.

## Reconnecting event streams

`maxReconnectAttempts` limits consecutive reconnects without progress, including a clean response that closes early. A new cursor or a healthy idle connection resets the limit. A generic stream without a cursor also resets the limit when it delivers an event. Session previews are delivered as they arrive and leave the durable cursor unchanged.

## Confirming vault and credential erasure

Deleting a vault returns a `vault_deleted` receipt. Read `secrets` to tell
whether storage confirmed every secret is gone. Deleting one credential returns
a `vault_credential_deleted` receipt. Read its `custody` field to tell whether
storage confirmed that secret is gone.

```ts
const vault = await client.vaults.delete(vaultId)
const vaultErased = vault.secrets === "erased"

const credential = await client.vaults.credentials.delete(otherVaultId, credentialId)
const credentialErased = credential.custody === "erased"
```

Treat `erasing` as still in progress. The original deletion has been recorded
and erasure continues in the background. Issue the same DELETE later to check
its current result. If your wait ends while the receipt still says `erasing`,
report that erasure is still in progress. Use `waitForPending` for resources
returned with `pending: true`.

## Checking a queued automation run

`automations.run` returns the queued run's `id`, `run` number, and the `session_id` it will use if it starts. To check the outcome, pass that `id` to `automationRuns.retrieve`. If the run result has yet to appear, this lookup waits briefly and can return `ServiceUnavailableError` (HTTP 503). Retry the GET. An unknown automation or a run it has never issued returns HTTP 404.

`automations.runs.retrieve` looks up a settled run by automation ID and run number. It returns HTTP 404 immediately until a run record appears. Both lookups return the same record after session creation succeeds or fails.

## Operation type helpers

```ts
import type { BodyOf, JsonResultOf, Op, QueryOf, ResultOf } from "@checkfu/sdk"

type CreateAgentInput = BodyOf<Op<"agents.create">>
type ListEventsQuery = QueryOf<Op<"sessions.events.list">>
type EffectAgent = ResultOf<Op<"agents.retrieve">>
type JsonAgent = JsonResultOf<Op<"agents.retrieve">>
```

## Retries, idempotency, and errors

- **Retries:** enabled by default (`maxRetries: 2`) with exponential backoff + jitter and `Retry-After` / `Retry-After-Ms` support. Safe retries automatically attach a stable `Idempotency-Key` on `agents.create`, `environments.create`, `sessions.create`, and `sessions.events.send` unless disabled (`autoIdempotencyKey: false`).
- **Errors:** every error is an Effect `Data.TaggedError` _and_ matches `instanceof` against `Checkfu.CheckfuError`, `Checkfu.APIError`, and status subclasses (`BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `PayloadTooLargeError`, `UnsupportedMediaTypeError`, `UnprocessableEntityError`, `RateLimitError`, `InternalServerError`, `ServiceUnavailableError`, `UnexpectedStatusError`, `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError`, `PaginationCursorCycleError`, `CheckfuConfigError`).
- **Security:** refuses non-loopback `http://` base URLs by default (`allowInsecureHttp: true` to opt in) and never follows 3xx redirects with credentials.
