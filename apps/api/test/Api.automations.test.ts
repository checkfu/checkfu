import { MAX_LIVE_AUTOMATIONS } from "@checkfu/domain/Automation/AutomationCapacity.aggregate"
import * as InMemory from "@alchemy.run/domain/InMemory"
import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Schedule from "effect/Schedule"
import { makeApiHandler } from "../src/Http/Router.ts"
import { AutomationReadWaitTimeout } from "../src/Http/AutomationsHandlers.ts"
import { AutomationView } from "@checkfu/domain/Automation/AutomationView.view"
import type { AutomationSnapshot } from "@checkfu/domain/Automation/AutomationView.view"
import { AutomationId } from "@checkfu/domain/Automation/Automation.id"
import { Automation } from "@checkfu/domain/Automation/Automation.aggregate"
import * as Domain from "@alchemy.run/domain"
import * as Option from "effect/Option"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import {
	AUTH_HEADERS,
	extractLastUserText,
	makeAssistantReply,
	makePiDurableTestLayer,
	sendRequest,
	waitForSession,
} from "./helpers/ApiHarness.ts"

type ApiFetch = Effect.Effect<
	HttpServerResponse.HttpServerResponse,
	never,
	HttpServerRequest.HttpServerRequest
>

interface AutomationBody {
	readonly id: string
	readonly type: string
	readonly name: string
	readonly description: string | null
	readonly updated_at: string
	readonly agent: { readonly id: string; readonly version: number | null }
	readonly environment_id: string
	readonly initial_events: ReadonlyArray<unknown>
	readonly schedule: {
		readonly type: string
		readonly expression: string
		readonly timezone: string
	}
	readonly status: string
	readonly pause_reason: string | null
	readonly run_count: number
	readonly last_run_at: string | null
	readonly upcoming_runs_at: ReadonlyArray<string>
	readonly archived_at: string | null
}

interface RunBody {
	readonly id: string
	readonly type: string
	readonly automation_id: string
	readonly run: number
	readonly status: string
	readonly trigger: { readonly type: string }
	readonly agent: { readonly id: string; readonly version: number | null }
	readonly session_id: string | null
	readonly error: { readonly type: string; readonly message: string } | null
}

interface ErrorBody {
	readonly error: { readonly type: string; readonly message: string }
}

const weekdayMornings = { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" }
const message = (text: string) => [{ type: "user.message", content: [{ type: "text", text }] }]

let createKeys = 0

const call = <A>(
	apiFetch: ApiFetch,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		const keyed =
			method === "POST" && path === "/v1/automations" && !("idempotency-key" in headers)
				? { "idempotency-key": `test-create-${++createKeys}` }
				: {}
		const response = yield* sendRequest(apiFetch, {
			method,
			path,
			headers: { ...AUTH_HEADERS, ...keyed, ...headers },
			...(body === undefined ? {} : { body }),
		})
		return {
			status: response.status,
			body: (yield* Effect.promise(() => response.json())) as A,
		}
	})

const prerequisites = (apiFetch: ApiFetch) =>
	Effect.gen(function* () {
		const agent = yield* call<{ id: string }>(apiFetch, "POST", "/v1/agents", {
			name: "Reporter",
			model: "gpt-4o-mini",
		})
		const environment = yield* call<{ id: string }>(apiFetch, "POST", "/v1/environments", {
			name: "Cloud",
		})
		return { agentId: agent.body.id, environmentId: environment.body.id }
	})

const NOW = "2026-01-05T12:00:00.000Z"

const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.clockWith((clock) =>
		Effect.provideService(effect, Clock.Clock, {
			currentTimeMillisUnsafe: () => Date.parse(NOW),
			currentTimeMillis: Effect.succeed(Date.parse(NOW)),
			currentTimeNanosUnsafe: () => BigInt(Date.parse(NOW)) * 1_000_000n,
			currentTimeNanos: Effect.succeed(BigInt(Date.parse(NOW)) * 1_000_000n),
			monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
			monotonicTimeNanos: clock.monotonicTimeNanos,
			sleep: (duration) => clock.sleep(duration),
		}),
	)

type Hosted = Layer.Success<ReturnType<typeof makePiDurableTestLayer>["layer"]>

const run = async <A>(
	body: (apiFetch: ApiFetch) => Effect.Effect<A, never, Hosted | Scope.Scope>,
): Promise<A> => {
	const { layer, closeAll } = makePiDurableTestLayer(
		async (model, context) =>
			makeAssistantReply(model, null, `Done: ${extractLastUserText(context)}`, 4, 2),
		{ platform: InMemory.make({ now: () => Date.parse(NOW) }).layer },
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				return yield* body(apiFetch)
			}).pipe(atNow, Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

interface ListBody {
	readonly data: ReadonlyArray<AutomationBody>
	readonly has_more: boolean
	readonly next_cursor: string | null
}

const listed = (apiFetch: ApiFetch, query: string, count: number) =>
	call<ListBody>(apiFetch, "GET", `/v1/automations${query}`).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (page) => page.body.data.length === count,
		}),
	)

const settledRuns = (apiFetch: ApiFetch, automationId: string, count: number) =>
	call<{ data: ReadonlyArray<RunBody>; has_more: boolean }>(
		apiFetch,
		"GET",
		`/v1/automations/${automationId}/runs`,
	).pipe(
		Effect.repeat({
			schedule: Schedule.spaced("5 millis"),
			times: 400,
			until: (page) => page.body.data.length >= count,
		}),
	)

describe("Automations API", () => {
	it("creates an automation, reads it back, and shows when it will next fire", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				expect(created.status).toBe(201)
				expect(created.body).toMatchObject({
					type: "automation",
					name: "Morning report",
					agent: { id: agentId, version: null },
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
					status: "active",
					pause_reason: null,
					run_count: 0,
					last_run_at: null,
					archived_at: null,
				})
				expect(created.body.id).toMatch(/^auto_[0-9a-f]{64}$/u)
				expect(created.body.upcoming_runs_at).toEqual([
					"2026-01-05T14:00:00.000Z",
					"2026-01-06T14:00:00.000Z",
					"2026-01-07T14:00:00.000Z",
					"2026-01-08T14:00:00.000Z",
					"2026-01-09T14:00:00.000Z",
				])
				expect(created.body).toMatchObject({ created_at: NOW, updated_at: NOW })

				const fetched = yield* call<AutomationBody>(
					apiFetch,
					"GET",
					`/v1/automations/${created.body.id}`,
				)
				expect(fetched.status).toBe(200)
				expect(fetched.body).toEqual(created.body)

				const pinned = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Pinned",
					agent: { type: "agent", id: agentId, version: 1 },
					environment_id: environmentId,
					initial_events: message("Go."),
					schedule: { type: "cron", expression: "30 6 1 * *", timezone: "UTC" },
				})
				expect(pinned.status).toBe(201)
				expect(pinned.body.agent).toEqual({ id: agentId, version: 1 })
			}),
		))

	it("opens its sessions whatever the network rules say or come to say, with no credentials", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const docs = "https://docs.mcp.example/mcp"
				const agent = yield* call<{ id: string }>(apiFetch, "POST", "/v1/agents", {
					name: "Reporter",
					model: "gpt-4o-mini",
					mcp_servers: [{ type: "url", name: "docs", url: docs }],
				})
				const open = yield* call<{ id: string }>(apiFetch, "POST", "/v1/environments", {
					name: "Open",
				})
				const forbidding = {
					type: "cloud",
					networking: {
						type: "limited",
						allow_mcp_servers: false,
						allow_package_managers: false,
						allowed_hosts: [],
					},
				}
				const closed = yield* call<{ id: string }>(apiFetch, "POST", "/v1/environments", {
					name: "Closed",
					config: forbidding,
				})
				const automationIn = (environmentId: string) =>
					call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
						name: "Docs digest",
						agent: agent.body.id,
						environment_id: environmentId,
						initial_events: message("Summarize the docs."),
						schedule: weekdayMornings,
					})

				const allowed = yield* automationIn(open.body.id)
				yield* call(apiFetch, "POST", `/v1/automations/${allowed.body.id}/run`)
				const started = yield* settledRuns(apiFetch, allowed.body.id, 1)
				expect(started.body.data[0]).toMatchObject({ status: "started", error: null })
				const session = yield* call<{ mcp_server_credentials: ReadonlyArray<unknown> }>(
					apiFetch,
					"GET",
					`/v1/sessions/sess_${allowed.body.id}_1`,
				)
				expect(session.body.mcp_server_credentials).toEqual([])

				const tightened = yield* call(apiFetch, "POST", `/v1/environments/${open.body.id}`, {
					version: 1,
					config: forbidding,
				})
				expect(tightened.status).toBe(200)
				yield* call(apiFetch, "POST", `/v1/automations/${allowed.body.id}/run`)
				const both = yield* settledRuns(apiFetch, allowed.body.id, 2)
				expect(both.body.data.map((fired) => [fired.status, fired.error])).toEqual([
					["started", null],
					["started", null],
				])
				const fromTheStart = yield* automationIn(closed.body.id)
				yield* call(apiFetch, "POST", `/v1/automations/${fromTheStart.body.id}/run`)
				const opened = yield* settledRuns(apiFetch, fromTheStart.body.id, 1)
				expect(opened.body.data[0]).toMatchObject({ status: "started", error: null })
			}),
		))

	it("runs on request in a new session that receives the automation's message", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id

				const first = yield* call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`)
				expect(first.status).toBe(201)
				expect(first.body).toEqual({
					type: "automation_run",
					id: `arun_${id}_1`,
					automation_id: id,
					run: 1,
					status: "queued",
					trigger: { type: "manual" },
				})

				const afterFirst = yield* settledRuns(apiFetch, id, 1)
				const recorded = afterFirst.body.data[0]
				expect(recorded).toMatchObject({
					run: 1,
					status: "started",
					trigger: { type: "manual" },
					agent: { id: agentId, version: 1 },
					session_id: `sess_${id}_1`,
					error: null,
				})
				const one = yield* call<RunBody>(apiFetch, "GET", `/v1/automations/${id}/runs/1`)
				expect([one.status, one.body]).toEqual([200, recorded])
				const byId = yield* call<RunBody>(apiFetch, "GET", `/v1/automation_runs/${first.body.id}`)
				expect([byId.status, byId.body]).toEqual([200, recorded])
				for (const [path, status] of [
					[`/v1/automation_runs/arun_${id}_02`, 404],
					[`/v1/automation_runs/arun_${id}_2`, 404],
					[`/v1/automations/${id}/runs/2`, 404],
					[`/v1/automations/auto_missing/runs/1`, 404],
					[`/v1/automations/${id}/runs/0`, 400],
					[`/v1/automations/${id}/runs/1.5`, 400],
					[`/v1/automations/${id}/runs/1.00000000000000001`, 400],
					[`/v1/automations/${id}/runs/01`, 400],
				] as const) {
					const missing = yield* call<ErrorBody>(apiFetch, "GET", path)
					expect([path, missing.status]).toEqual([path, status])
				}
				yield* waitForSession(
					apiFetch,
					`sess_${id}_1`,
					(session) => session.status === "idle" && session.turn === 1,
				)
				const session = yield* call<{
					agent: { id: string; version: number }
					environment_id: string
					title: string
				}>(apiFetch, "GET", `/v1/sessions/sess_${id}_1`)
				expect(session.body).toMatchObject({
					agent: { id: agentId, version: 1 },
					environment_id: environmentId,
					title: "Morning report",
				})
				const events = yield* call<{
					data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
				}>(apiFetch, "GET", `/v1/sessions/sess_${id}_1/events`)
				expect(
					events.body.data
						.filter((event) => event.type === "user.message" || event.type === "agent.message")
						.map((event) => [event.type, event.content?.[0]?.text]),
				).toEqual([
					["user.message", "Write the morning report."],
					["agent.message", "Done: Write the morning report."],
				])

				yield* call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`)
				const afterSecond = yield* settledRuns(apiFetch, id, 2)
				const second = yield* call<RunBody>(apiFetch, "GET", `/v1/automations/${id}/runs/2`)
				expect([second.status, second.body]).toEqual([200, afterSecond.body.data[1]])
				expect(afterSecond.body.data.map((entry) => [entry.run, entry.session_id])).toEqual([
					[1, `sess_${id}_1`],
					[2, `sess_${id}_2`],
				])
				const newestFirst = yield* call<{ data: ReadonlyArray<RunBody> }>(
					apiFetch,
					"GET",
					`/v1/automations/${id}/runs?order=desc`,
				)
				expect(newestFirst.body.data.map((entry) => entry.run)).toEqual([2, 1])
				const oldestFirst = yield* call<{
					data: ReadonlyArray<RunBody>
					has_more: boolean
					next_cursor: number | null
				}>(apiFetch, "GET", `/v1/automations/${id}/runs?order=asc&limit=1`)
				expect(oldestFirst.body.data.map((entry) => entry.run)).toEqual([1])
				expect(oldestFirst.body.has_more).toBe(true)
				const rest = yield* call<{ data: ReadonlyArray<RunBody>; has_more: boolean }>(
					apiFetch,
					"GET",
					`/v1/automations/${id}/runs?order=asc&limit=1&after=${oldestFirst.body.next_cursor}`,
				)
				expect(rest.body.data.map((entry) => entry.run)).toEqual([2])

				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body.run_count).toBe(2)
				expect(fetched.body.last_run_at).not.toBeNull()
			}),
		))

	it("gives each of several concurrent run requests its own run number", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				const requested = yield* Effect.forEach(
					Array.from({ length: 25 }),
					() => call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`),
					{ concurrency: 25 },
				)
				expect(requested.map((entry) => entry.status)).toEqual(
					Array.from({ length: 25 }, () => 201),
				)
				const numbers = requested.map((entry) => entry.body.run).toSorted((a, b) => a - b)
				expect(numbers).toEqual(Array.from({ length: 25 }, (_, index) => index + 1))

				const settled = yield* settledRuns(apiFetch, id, 25)
				expect(
					settled.body.data.map((entry) => [entry.run, entry.status, entry.session_id]),
				).toEqual(numbers.map((number) => [number, "started", `sess_${id}_${number}`]))
			}),
		))

	it("accepts named GMT aliases and serves a sparse schedule's next firings without recomputing them", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const create = (expression: string, timezone: string) =>
					call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
						name: "Morning report",
						agent: agentId,
						environment_id: environmentId,
						initial_events: message("Write the morning report."),
						schedule: { type: "cron", expression, timezone },
					})
				for (const timezone of ["GMT+0", "GMT-0"]) {
					const created = yield* create("0 9 * * *", timezone)
					expect([timezone, created.status]).toEqual([timezone, 201])
				}
				const sparse = yield* create("59 23 29 2 */7", "America/New_York")
				expect(sparse.status).toBe(201)
				expect(sparse.body.upcoming_runs_at).toHaveLength(5)
				for (let read = 0; read < 20; read++) {
					const fetched = yield* call<AutomationBody>(
						apiFetch,
						"GET",
						`/v1/automations/${sparse.body.id}`,
					)
					expect(fetched.body.upcoming_runs_at).toEqual(sparse.body.upcoming_runs_at)
				}
			}),
		))

	it("answers a lifecycle request that changes nothing at once, after a run has been recorded", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				yield* call(apiFetch, "POST", `/v1/automations/${id}/run`)
				yield* settledRuns(apiFetch, id, 1)
				const unpaused = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/unpause`,
				)
				expect([unpaused.status, unpaused.body.status]).toEqual([200, "active"])

				yield* call(apiFetch, "POST", `/v1/automations/${id}/pause`)
				yield* call(apiFetch, "POST", `/v1/automations/${id}/run`)
				yield* settledRuns(apiFetch, id, 2)
				const pausedAgain = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/pause`,
				)
				expect([pausedAgain.status, pausedAgain.body.status]).toEqual([200, "paused"])
			}),
		))

	it("pauses, unpauses and archives, and refuses changes once archived", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id

				const paused = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}/pause`)
				expect(paused.status).toBe(200)
				expect(paused.body).toMatchObject({
					status: "paused",
					pause_reason: "manual",
					upcoming_runs_at: [],
				})
				const pausedAgain = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/pause`,
				)
				expect(pausedAgain.body.status).toBe("paused")

				const whilePaused = yield* call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`)
				expect(whilePaused.status).toBe(201)
				expect(whilePaused.body.run).toBe(1)

				const unpaused = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/unpause`,
				)
				expect(unpaused.body).toMatchObject({ status: "active", pause_reason: null })
				expect(unpaused.body.upcoming_runs_at).toHaveLength(5)

				const archived = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/archive`,
				)
				expect(archived.body.status).toBe("archived")
				expect(archived.body.archived_at).not.toBeNull()
				expect(archived.body.upcoming_runs_at).toEqual([])

				for (const action of ["pause", "unpause", "run"]) {
					const refused = yield* call<ErrorBody>(
						apiFetch,
						"POST",
						`/v1/automations/${id}/${action}`,
					)
					expect([action, refused.status, refused.body.error.type]).toEqual([
						action,
						409,
						"conflict_error",
					])
				}
				const archivedAgain = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/archive`,
				)
				expect(archivedAgain.status).toBe(200)
			}),
		))

	it("lists automations a page at a time in either order, by agent, with or without archived ones", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const otherAgent = yield* call<{ id: string }>(apiFetch, "POST", "/v1/agents", {
					name: "Other",
					model: "gpt-4o-mini",
				})
				const empty = yield* call<ListBody>(apiFetch, "GET", "/v1/automations")
				expect(empty).toEqual({
					status: 200,
					body: { data: [], has_more: false, next_cursor: null },
				})
				const ids: Array<string> = []
				for (const [name, agent] of [
					["First", agentId],
					["Second", agentId],
					["Third", otherAgent.body.id],
				] as const) {
					const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
						name,
						agent,
						environment_id: environmentId,
						initial_events: message(`Run ${name}.`),
						schedule: weekdayMornings,
					})
					ids.push(created.body.id)
				}
				const all = yield* listed(apiFetch, "", 3)
				const order = all.body.data.map((automation) => automation.id)
				expect(order.toSorted()).toEqual(ids.toSorted())
				expect(all.body).toMatchObject({ has_more: false, next_cursor: null })
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${ids[0]}`)
				expect(all.body.data.find((automation) => automation.id === ids[0])).toEqual(fetched.body)

				const pages = (query: string) =>
					Effect.gen(function* () {
						const seen: Array<string> = []
						let after: string | null = null
						do {
							const cursor: string = after === null ? "" : `&after=${after}`
							const page = yield* call<ListBody>(
								apiFetch,
								"GET",
								`/v1/automations?limit=1${query}${cursor}`,
							)
							seen.push(...page.body.data.map((automation) => automation.id))
							after = page.body.next_cursor
							expect(page.body.has_more).toBe(after !== null)
						} while (after !== null)
						return seen
					})
				expect(yield* pages("")).toEqual(order)
				expect(yield* pages("&order=desc")).toEqual(order.toReversed())

				const byAgent = yield* call<ListBody>(
					apiFetch,
					"GET",
					`/v1/automations?agent_id=${agentId}`,
				)
				expect(byAgent.body.data.map((automation) => automation.id).toSorted()).toEqual(
					ids.slice(0, 2).toSorted(),
				)

				yield* call(apiFetch, "POST", `/v1/automations/${ids[1]}`, { agent: otherAgent.body.id })
				const stayed = yield* listed(apiFetch, `?agent_id=${agentId}`, 1)
				expect(stayed.body.data.map((automation) => automation.id)).toEqual([ids[0]])
				const moved = yield* listed(apiFetch, `?agent_id=${otherAgent.body.id}`, 2)
				expect(moved.body.data.map((automation) => automation.id).toSorted()).toEqual(
					ids.slice(1).toSorted(),
				)

				yield* call(apiFetch, "POST", `/v1/automations/${ids[1]}/pause`)
				yield* call(apiFetch, "POST", `/v1/automations/${ids[0]}/archive`)
				const remaining = yield* listed(apiFetch, "", 2)
				expect(
					Object.fromEntries(
						remaining.body.data.map((automation) => [automation.id, automation.status]),
					),
				).toEqual({ [String(ids[1])]: "paused", [String(ids[2])]: "active" })
				const withArchived = yield* call<ListBody>(
					apiFetch,
					"GET",
					"/v1/automations?include_archived=true",
				)
				expect(withArchived.body.data.map((automation) => automation.id)).toEqual(order)
				expect(withArchived.body.data.find((automation) => automation.id === ids[0])?.status).toBe(
					"archived",
				)
			}),
		))

	it("lists while the listing is ahead of an automation's own view: waits for it, answers 503 with no page, or leaves out what the view no longer matches", () =>
		run(() =>
			Effect.gen(function* () {
				const views = yield* AutomationView
				let lag: "off" | "missing" | "timeout" | "archived" | "moved" = "off"
				let waits = 0
				const lagging = {
					...views,
					get: (ref: Parameters<typeof views.get>[0], options?: Parameters<typeof views.get>[1]) =>
						lag === "off"
							? views.get(ref, options)
							: lag === "archived"
								? Effect.map(
										views.get(ref, options),
										Option.map((state) =>
											state === null
												? state
												: { ...state, status: "archived" as const, archived_at: state.updated_at },
										),
									)
								: lag === "moved"
									? Effect.map(
											views.get(ref, options),
											Option.map((state) =>
												state === null ? state : { ...state, agent_id: "agent_elsewhere" },
											),
										)
									: Effect.succeedNone,
					waitFor: (
						ref: Parameters<typeof views.waitFor>[0],
						where: Parameters<typeof views.waitFor>[1],
						options: Parameters<typeof views.waitFor>[2],
					) => {
						waits += 1
						return lag === "timeout"
							? Effect.fail(new Domain.WaitTimeout({ view: "AutomationView", key: ref.id }))
							: views.waitFor(ref, where, options)
					},
				} as unknown as typeof views
				const { fetch: apiFetch } = yield* makeApiHandler.pipe(
					Effect.provideService(AutomationView, lagging),
					Effect.provideService(AutomationReadWaitTimeout, "50 millis"),
				)
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Lagging",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Report."),
					schedule: weekdayMornings,
				})
				yield* listed(apiFetch, "", 1)

				lag = "missing"
				const waited = yield* call<ListBody>(apiFetch, "GET", "/v1/automations?limit=1")
				expect([waited.status, waited.body.data.map((automation) => automation.id), waits]).toEqual(
					[200, [created.body.id], 1],
				)

				lag = "timeout"
				const unavailable = yield* call<ErrorBody & Partial<ListBody>>(
					apiFetch,
					"GET",
					"/v1/automations?limit=1",
				)
				expect([
					unavailable.status,
					unavailable.body.next_cursor,
					unavailable.body.data,
					waits,
				]).toEqual([503, undefined, undefined, 2])

				lag = "archived"
				const archived = yield* call<ListBody>(apiFetch, "GET", "/v1/automations?limit=1")
				expect([archived.status, archived.body.data, waits]).toEqual([200, [], 2])

				lag = "moved"
				const moved = yield* call<ListBody>(apiFetch, "GET", `/v1/automations?agent_id=${agentId}`)
				expect([moved.status, moved.body.data, waits]).toEqual([200, [], 2])
				const unfiltered = yield* call<ListBody>(apiFetch, "GET", "/v1/automations")
				expect(unfiltered.body.data.map((automation) => automation.agent.id)).toEqual([
					"agent_elsewhere",
				])
			}),
		))

	it("refuses list paging values it cannot use", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				for (const query of ["limit=0", "limit=101", "after=-1", "order=newest"]) {
					const refused = yield* call<ErrorBody>(apiFetch, "GET", `/v1/automations?${query}`)
					expect([query, refused.status]).toEqual([query, 400])
				}
			}),
		))

	it("updates the fields it is given, keeps the rest, and runs later sessions with the update", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					description: "Every weekday morning.",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				expect(created.body.description).toBe("Every weekday morning.")

				const renamed = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					name: "Weekday report",
				})
				expect(renamed.status).toBe(200)
				const views = yield* AutomationView
				const viewed = views.get(Automation.ref(AutomationId.make(id))).pipe(
					Effect.map((found) => Option.getOrNull(found)),
					Effect.orDie,
				)
				const activationOf = Effect.map(viewed, (found) => found?.activation)
				const revisionOf = Effect.map(viewed, (found) => found?.revision)
				expect(yield* activationOf).toBe(0)
				const again = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					name: "Weekday report",
				})
				expect([again.status, again.body]).toEqual([200, renamed.body])
				expect(yield* revisionOf).toBe(2)
				expect(renamed.body).toEqual({
					...created.body,
					name: "Weekday report",
					updated_at: renamed.body.updated_at,
				})

				const noon = { type: "cron", expression: "0 13 * * *", timezone: "UTC" }
				const changed = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					description: null,
					agent: { type: "agent", id: agentId, version: 1 },
					initial_events: message("Write the noon report."),
					schedule: noon,
				})
				expect(changed.status).toBe(200)
				expect(changed.body).toMatchObject({
					name: "Weekday report",
					description: null,
					agent: { id: agentId, version: 1 },
					environment_id: environmentId,
					initial_events: message("Write the noon report."),
					schedule: noon,
					status: "active",
				})
				expect(changed.body.upcoming_runs_at).toEqual([
					"2026-01-05T13:00:00.000Z",
					"2026-01-06T13:00:00.000Z",
					"2026-01-07T13:00:00.000Z",
					"2026-01-08T13:00:00.000Z",
					"2026-01-09T13:00:00.000Z",
				])
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body).toEqual(changed.body)
				expect(yield* activationOf).toBe(1)

				yield* call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`)
				yield* settledRuns(apiFetch, id, 1)
				yield* waitForSession(
					apiFetch,
					`sess_${id}_1`,
					(session) => session.status === "idle" && session.turn === 1,
				)
				const session = yield* call<{ title: string }>(apiFetch, "GET", `/v1/sessions/sess_${id}_1`)
				expect(session.body.title).toBe("Weekday report")
				const events = yield* call<{
					data: ReadonlyArray<{ type: string; content?: ReadonlyArray<{ text: string }> }>
				}>(apiFetch, "GET", `/v1/sessions/sess_${id}_1/events`)
				expect(
					events.body.data
						.filter((event) => event.type === "user.message")
						.map((event) => event.content?.[0]?.text),
				).toEqual(["Write the noon report."])
			}),
		))

	it("keeps both of two concurrent updates that change different fields", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				const afternoon = { type: "cron", expression: "0 13 * * *", timezone: "UTC" }
				const [renamed, rescheduled] = yield* Effect.all(
					[
						call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, { name: "Renamed" }),
						call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
							schedule: afternoon,
						}),
					],
					{ concurrency: "unbounded" },
				)
				expect([renamed.status, rescheduled.status]).toEqual([200, 200])
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body).toMatchObject({ name: "Renamed", schedule: afternoon })
			}),
		))

	it("applies an update the view has not caught up with, and refuses an unchanged update to an archived automation", () =>
		run(() =>
			Effect.gen(function* () {
				const views = yield* AutomationView
				let stale: AutomationSnapshot | undefined
				const lagging = {
					...views,
					get: (
						ref: Parameters<typeof views.get>[0],
						options?: Parameters<typeof views.get>[1],
					) => {
						const once = stale
						stale = undefined
						return once === undefined ? views.get(ref, options) : Effect.succeedSome(once)
					},
				} as unknown as typeof views
				const { fetch: apiFetch } = yield* makeApiHandler.pipe(
					Effect.provideService(AutomationView, lagging),
				)
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "A",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				const ref = Automation.ref(AutomationId.make(id))
				const before = Option.getOrNull(yield* Effect.orDie(views.get(ref)))
				yield* call(apiFetch, "POST", `/v1/automations/${id}`, { name: "B" })

				stale = before ?? undefined
				const back = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					name: "A",
				})
				expect([back.status, back.body.name]).toEqual([200, "A"])
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body.name).toBe("A")

				yield* call(apiFetch, "POST", `/v1/automations/${id}/archive`)
				const archived = yield* call<ErrorBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					name: "A",
				})
				expect([archived.status, archived.body.error.type]).toEqual([409, "conflict_error"])
			}),
		))

	it("changes the cron expression and the timezone separately, keeping both of two concurrent edits", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				const zoned = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					schedule: { timezone: "Europe/London" },
				})
				expect(zoned.body.schedule).toEqual({ ...weekdayMornings, timezone: "Europe/London" })
				yield* Effect.all(
					[
						call(apiFetch, "POST", `/v1/automations/${id}`, {
							schedule: { timezone: "Asia/Tokyo" },
						}),
						call(apiFetch, "POST", `/v1/automations/${id}`, {
							schedule: { expression: "0 13 * * *" },
						}),
					],
					{ concurrency: "unbounded" },
				)
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body.schedule).toEqual({
					type: "cron",
					expression: "0 13 * * *",
					timezone: "Asia/Tokyo",
				})
			}),
		))

	it("updates a paused automation without starting it, and refuses what it cannot update", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				yield* call(apiFetch, "POST", `/v1/automations/${id}/pause`)
				const noon = { type: "cron", expression: "0 13 * * *", timezone: "UTC" }
				const paused = yield* call<AutomationBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					schedule: noon,
				})
				expect(paused.body).toMatchObject({
					status: "paused",
					schedule: noon,
					upcoming_runs_at: [],
				})
				const unpaused = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					`/v1/automations/${id}/unpause`,
				)
				expect(unpaused.body.upcoming_runs_at[0]).toBe("2026-01-05T13:00:00.000Z")

				const refusals: ReadonlyArray<readonly [string, unknown, number]> = [
					["/v1/automations/auto_missing", { name: "x" }, 404],
					[
						`/v1/automations/${id}`,
						{ schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } },
						400,
					],
					[`/v1/automations/${id}`, { agent: "agent_missing" }, 404],
					[`/v1/automations/${id}`, { agent: { type: "agent", id: agentId, version: 9 } }, 404],
					[`/v1/automations/${id}`, { environment_id: "env_missing" }, 404],
					[`/v1/automations/${id}`, { initial_events: [] }, 400],
					[`/v1/automations/${id}`, { name: "" }, 400],
					[`/v1/automations/${id}`, { description: "x".repeat(2049) }, 400],
				]
				for (const [path, body, status] of refusals) {
					const refused = yield* call<ErrorBody>(apiFetch, "POST", path, body)
					expect([path, body, refused.status]).toEqual([path, body, status])
				}
				const unchanged = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(unchanged.body).toEqual(unpaused.body)

				yield* call(apiFetch, "POST", `/v1/automations/${id}/archive`)
				const archived = yield* call<ErrorBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					name: "Too late",
				})
				expect([archived.status, archived.body.error.type]).toEqual([409, "conflict_error"])
				const unusable = yield* call<ErrorBody>(apiFetch, "POST", `/v1/automations/${id}`, {
					schedule: { timezone: "Mars/Olympus" },
				})
				expect(unusable.status).toBe(400)
			}),
		))

	it("pauses itself when a run cannot start because its agent was archived", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const created = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				})
				const id = created.body.id
				yield* call(apiFetch, "POST", `/v1/agents/${agentId}/archive`)
				yield* call<RunBody>(apiFetch, "POST", `/v1/automations/${id}/run`)

				const runs = yield* settledRuns(apiFetch, id, 1)
				expect(runs.body.data[0]).toMatchObject({
					run: 1,
					status: "failed",
					agent: { id: agentId, version: null },
					session_id: null,
					error: { type: "agent_unavailable" },
				})
				const fetched = yield* call<AutomationBody>(apiFetch, "GET", `/v1/automations/${id}`)
				expect(fetched.body).toMatchObject({
					status: "paused",
					pause_reason: "agent_unavailable",
				})
				const session = yield* call<ErrorBody>(apiFetch, "GET", `/v1/sessions/sess_${id}_1`)
				expect(session.status).toBe(404)
			}),
		))

	it("refuses schedules it cannot run and resources that are not available", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const base = {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				}
				const schedule = (expression: string, timezone = "UTC") => ({
					schedule: { type: "cron", expression, timezone },
				})

				const refusals = [
					["every minute", schedule("* * * * *"), 400],
					["every half hour", schedule("*/30 * * * *"), 400],
					["twice an hour", schedule("0,30 * * * *"), 400],
					["two firings in one minute", schedule("*/30 0 9 * * *"), 400],
					["four fields", schedule("0 9 * *"), 400],
					["macro", schedule("@daily"), 400],
					["hour out of range", schedule("0 24 * * *"), 400],
					["never fires", schedule("0 0 31 2 *"), 400],
					["unknown time zone", schedule("0 9 * * *", "Mars/Olympus"), 400],
					["offset time zone", schedule("0 9 * * *", "+02:00"), 400],
					["impossible offset", schedule("0 9 * * *", "+99:99"), 400],
					["hour-only offset", schedule("0 9 * * *", "+02"), 400],
					["negative zero offset", schedule("0 9 * * *", "-00"), 400],
					["empty time zone", schedule("0 9 * * *", ""), 400],
					["interval type", { schedule: { type: "interval", every: "1 hour" } }, 400],
					["two messages", { initial_events: [...message("a"), ...message("b")] }, 400],
					["no message", { initial_events: [] }, 400],
					["field the schema does not declare", { budget: { max: 1 } }, 400],
					["unknown agent", { agent: "agent_missing" }, 404],
					["agent reference that is not an id", { agent: "team/agent" }, 404],
					[
						"pinned agent reference that is not an id",
						{ agent: { type: "agent", id: "..", version: 1 } },
						404,
					],
					["environment reference that is not an id", { environment_id: "team/env" }, 404],
					["unknown agent version", { agent: { type: "agent", id: agentId, version: 9 } }, 404],
					["unknown environment", { environment_id: "env_missing" }, 404],
				] as const
				const everyMinute = yield* call<ErrorBody>(apiFetch, "POST", "/v1/automations", {
					...base,
					...schedule("* * * * *"),
				})
				expect(everyMinute.body.error.message).toContain("fires at most once per clock hour")
				for (const [label, overrides, status] of refusals) {
					const refused = yield* call<ErrorBody>(apiFetch, "POST", "/v1/automations", {
						...base,
						...overrides,
					})
					expect([label, refused.status]).toEqual([label, status])
				}

				const offset = yield* call<ErrorBody>(apiFetch, "POST", "/v1/automations", {
					...base,
					...schedule("0 9 * * *", "+02:00"),
				})
				expect(offset.body.error.message).toContain("IANA time zone name")

				yield* call(apiFetch, "POST", `/v1/environments/${environmentId}/archive`)
				const archivedEnvironment = yield* call<ErrorBody>(
					apiFetch,
					"POST",
					"/v1/automations",
					base,
				)
				expect(archivedEnvironment.status).toBe(409)

				for (const [method, path] of [
					["GET", "/v1/automations/auto_missing"],
					["GET", "/v1/automations/auto_missing/runs"],
					["POST", "/v1/automations/auto_missing/pause"],
					["POST", "/v1/automations/auto_missing/unpause"],
					["POST", "/v1/automations/auto_missing/archive"],
					["POST", "/v1/automations/auto_missing/run"],
				] as const) {
					const missing = yield* call<ErrorBody>(apiFetch, method, path)
					expect([path, missing.status]).toEqual([path, 404])
				}
			}),
		))

	it("returns the same automation for a retried create and refuses a changed one", () =>
		run((apiFetch) =>
			Effect.gen(function* () {
				const { agentId, environmentId } = yield* prerequisites(apiFetch)
				const body = {
					name: "Morning report",
					agent: agentId,
					environment_id: environmentId,
					initial_events: message("Write the morning report."),
					schedule: weekdayMornings,
				}
				const corrected = { "idempotency-key": "create-after-a-bad-schedule" }
				const unusable = yield* call<ErrorBody>(
					apiFetch,
					"POST",
					"/v1/automations",
					{ ...body, schedule: { type: "cron", expression: "0 0 31 2 *", timezone: "UTC" } },
					corrected,
				)
				expect(unusable.status).toBe(400)
				const afterCorrection = yield* call<AutomationBody>(
					apiFetch,
					"POST",
					"/v1/automations",
					body,
					corrected,
				)
				expect(afterCorrection.status).toBe(201)

				const unkeyed = yield* sendRequest(apiFetch, {
					method: "POST",
					path: "/v1/automations",
					headers: AUTH_HEADERS,
					body,
				})
				expect(unkeyed.status).toBe(400)
				const key = { "idempotency-key": "create-morning-report" }
				const first = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", body, key)
				expect(first.status).toBe(201)
				yield* call(apiFetch, "POST", `/v1/agents/${agentId}/archive`)
				const retried = yield* call<AutomationBody>(apiFetch, "POST", "/v1/automations", body, key)
				expect(retried.status).toBe(201)
				expect(retried.body.id).toBe(first.body.id)
				const changed = yield* call<ErrorBody>(
					apiFetch,
					"POST",
					"/v1/automations",
					{ ...body, name: "Evening report" },
					key,
				)
				expect(changed.status).toBe(409)
				const unusableUnderTheSameKey = yield* call<ErrorBody>(
					apiFetch,
					"POST",
					"/v1/automations",
					{
						...body,
						schedule: { type: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" },
					},
					key,
				)
				expect(unusableUnderTheSameKey.status).toBe(400)
			}),
		))

	it(
		"lets exactly one of two competing creates take the last slot, and frees a slot on archive",
		() =>
			run((apiFetch) =>
				Effect.gen(function* () {
					const { agentId, environmentId } = yield* prerequisites(apiFetch)
					const body = {
						name: "Morning report",
						agent: agentId,
						environment_id: environmentId,
						initial_events: message("Write the morning report."),
						schedule: weekdayMornings,
					}
					const create = call<AutomationBody>(apiFetch, "POST", "/v1/automations", body)
					const filled = yield* Effect.forEach(
						Array.from({ length: MAX_LIVE_AUTOMATIONS - 1 }),
						() => create,
						{ concurrency: 10 },
					)
					expect(filled.map((entry) => entry.status)).toEqual(
						Array.from({ length: MAX_LIVE_AUTOMATIONS - 1 }, () => 201),
					)

					const competing = yield* Effect.all([create, create], { concurrency: 2 })
					expect(competing.map((entry) => entry.status).toSorted((a, b) => a - b)).toEqual([
						201, 429,
					])
					const refused = yield* call<ErrorBody>(apiFetch, "POST", "/v1/automations", body)
					expect(refused.status).toBe(429)
					expect(refused.body.error.type).toBe("rate_limit_error")

					const first = filled[0]
					if (first === undefined) {
						return yield* Effect.die(new Error("no automation was created"))
					}
					yield* call(apiFetch, "POST", `/v1/automations/${first.body.id}/archive`)
					const admitted = yield* create.pipe(
						Effect.repeat({
							schedule: Schedule.spaced("5 millis"),
							times: 400,
							until: (response) => response.status === 201,
						}),
					)
					expect(admitted.status).toBe(201)
					expect((yield* create).status).toBe(429)
				}),
			),
		30_000,
	)
})
