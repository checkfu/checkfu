import { MAX_LIVE_AUTOMATIONS } from "@checkfu/domain/Automation/AutomationCapacity.aggregate"
import * as InMemory from "@alchemy.run/domain/InMemory"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Schedule from "effect/Schedule"
import { makeApiHandler } from "../src/Http/Router.ts"
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
	readonly type: string
	readonly automation_id: string
	readonly run: number
	readonly status: string
	readonly trigger: { readonly type: string }
	readonly session_id: string | null
	readonly error: { readonly type: string; readonly message: string } | null
}

interface ErrorBody {
	readonly error: { readonly type: string; readonly message: string }
}

const weekdayMornings = { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" }
const message = (text: string) => [{ type: "user.message", content: [{ type: "text", text }] }]

const call = <A>(
	apiFetch: ApiFetch,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		const response = yield* sendRequest(apiFetch, {
			method,
			path,
			headers: { ...AUTH_HEADERS, ...headers },
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

const run = async <A>(body: (apiFetch: ApiFetch) => Effect.Effect<A>): Promise<A> => {
	const { layer, closeAll } = makePiDurableTestLayer(
		async (model, context) =>
			makeAssistantReply(model, null, `Done: ${extractLastUserText(context)}`, 4, 2),
		undefined,
		InMemory.make({ now: () => Date.parse(NOW) }).layer,
	)
	try {
		return await Effect.runPromise(
			Effect.gen(function* () {
				const { fetch: apiFetch } = yield* makeApiHandler
				return yield* body(apiFetch)
			}).pipe(Effect.scoped, Effect.provide(layer)),
		)
	} finally {
		await closeAll()
	}
}

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
				expect(created.body.id).toMatch(/^auto_[0-9a-f]{24}$/u)
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
					agent: { id: agentId, version: 1 },
					environment_id: environmentId,
					initial_events: message("Go."),
					schedule: { type: "cron", expression: "30 6 1 * *", timezone: "UTC" },
				})
				expect(pinned.status).toBe(201)
				expect(pinned.body.agent).toEqual({ id: agentId, version: 1 })
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
					session_id: `sess_${id}_1`,
					error: null,
				})
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
					["empty time zone", schedule("0 9 * * *", ""), 400],
					["interval type", { schedule: { type: "interval", every: "1 hour" } }, 400],
					["two messages", { initial_events: [...message("a"), ...message("b")] }, 400],
					["no message", { initial_events: [] }, 400],
					["field the schema does not declare", { budget: { max: 1 } }, 400],
					["unknown agent", { agent: "agent_missing" }, 404],
					["agent reference that is not an id", { agent: "team/agent" }, 404],
					["pinned agent reference that is not an id", { agent: { id: "..", version: 1 } }, 404],
					["environment reference that is not an id", { environment_id: "team/env" }, 404],
					["unknown agent version", { agent: { id: agentId, version: 9 } }, 404],
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
