import { readFileSync } from "node:fs"
import { AgentState } from "@checkfu/agents/Agent/Agent.aggregate"
import { AbandonTurn } from "@checkfu/sessions/Session/AbandonTurn.command"
import { snapshotVersion, versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import { RUN_TURN_ACTIVITIES, RunTurn } from "@checkfu/sessions/Session/RunTurn.saga"
import { UserMessage } from "@checkfu/sessions/Session/SendUserMessage.command"
import { TurnInputState } from "@checkfu/sessions/Session/TurnInput.view"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
	LOCK_FILE_URL,
	type PersistedLock,
	cutBaseline,
	decodeFailure,
	decodeLock,
	lockProblems,
	sampleEncoded,
	schemaFingerprint,
	shipBlockers,
} from "./persisted/Lock.ts"
import {
	type PersistedShape,
	persistedShapes,
	policyDeliveryShapeId,
	registryProblems,
	viewShapeId,
} from "./persisted/Shapes.ts"

const shapeOfKind = (kind: PersistedShape["kind"]): PersistedShape => {
	const shape = persistedShapes.find((candidate) => candidate.kind === kind)
	if (shape === undefined) throw new Error(`no ${kind} shape is registered`)
	return shape
}

const replacing = (id: string, schema: Schema.Top): ReadonlyArray<PersistedShape> => {
	expect(persistedShapes.map((shape) => shape.id)).toContain(id)
	return persistedShapes.map((shape) =>
		shape.id === id ? { ...shape, schema: schema as unknown as PersistedShape["schema"] } : shape,
	)
}

const reviewing = (
	lock: PersistedLock,
	id: string,
	shapes: ReadonlyArray<PersistedShape>,
): PersistedLock => {
	const shape = shapes.find((candidate) => candidate.id === id)
	if (shape === undefined) throw new Error(`no shape ${id}`)
	return {
		...lock,
		reviewed: { [id]: { schema: schemaFingerprint(shape), reason: "Checked in a test." } },
	}
}

const lockWith = (
	shapes: Record<string, ReadonlyArray<unknown>>,
	retired: Record<string, string> = {},
): PersistedLock => ({
	version: 1,
	retired,
	reviewed: {},
	baselines: [{ label: "test-baseline", cut_at: "2026-01-01T00:00:00.000Z", schemas: {}, shapes }],
})

describe("persisted shapes", () => {
	it("finds every event, state, view and saga shape the hosted models declare", () => {
		expect(registryProblems()).toEqual([])
		expect(persistedShapes.filter((shape) => shape.kind === "state").length).toBe(4)
		expect(persistedShapes.map((shape) => shape.id)).toContain("saga-input:Sessions.RunTurn")
	})

	it("writes every shape in a JSON form the same code reads back", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const unreadable: Array<string> = []
				for (const shape of persistedShapes) {
					const samples = yield* sampleEncoded(shape, 4)
					if (samples.length !== 4) unreadable.push(`${shape.id}: ${samples.length} samples`)
					for (const sample of samples) {
						const failure = yield* decodeFailure(shape, sample)
						if (failure !== null) unreadable.push(`${shape.id}: ${failure}`)
					}
				}
				expect(unreadable).toEqual([])
			}),
		))

	it("still reads everything written by every shipped baseline", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const lock = yield* decodeLock(JSON.parse(readFileSync(LOCK_FILE_URL, "utf8")) as unknown)
				expect(yield* lockProblems(lock)).toEqual([])
			}),
		))
})

describe("persisted shape lock", () => {
	it("accepts a baseline cut from the current code", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const baseline = yield* cutBaseline("now", "2026-01-01T00:00:00.000Z")
				expect(Object.keys(baseline.shapes).length).toBe(persistedShapes.length)
				expect(
					yield* lockProblems({ version: 1, retired: {}, reviewed: {}, baselines: [baseline] }),
				).toEqual([])
			}),
		))

	it("reports a shipped value the current schema can no longer read, with the rule", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const event = shapeOfKind("event")
				const problems = yield* lockProblems(lockWith({ [event.id]: [{ not: "this event" }] }))
				expect(problems.length).toBe(1)
				expect(problems[0]).toContain(event.id)
				expect(problems[0]).toContain('baseline "test-baseline"')
				expect(problems[0]).toContain("Events are permanent")
			}),
		))

	it("reports a shipped shape nothing reads any more, unless it is retired", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const gone = "event:Sessions.Session/removed.event"
				const dropped = yield* lockProblems(lockWith({ [gone]: [{}] }))
				expect(dropped.length).toBe(1)
				expect(dropped[0]).toContain(gone)
				expect(dropped[0]).toContain('"retired"')

				const retired = yield* lockProblems(
					lockWith(
						{ [gone]: [{}] },
						{ [gone]: "Replaced by removed.event_v2; no stream holds it." },
					),
				)
				expect(retired).toEqual([])
			}),
		))

	it("fails a saga input that gains a required field or breaks __cause, and passes an optional one", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "saga-input:Sessions.RunTurn"
				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }
				const payloadFields = (
					RunTurn.workflow.payloadSchema as unknown as {
						readonly fields: Schema.Struct.Fields
					}
				).fields
				expect("__cause" in payloadFields).toBe(true)

				const withInput = (extra: Schema.Struct.Fields): ReadonlyArray<PersistedShape> =>
					persistedShapes.map((shape) =>
						shape.id === id
							? {
									...shape,
									schema: Schema.Struct({
										...payloadFields,
										...extra,
									}) as unknown as PersistedShape["schema"],
								}
							: shape,
					)

				const required = yield* lockProblems(lock, withInput({ added_later: Schema.Number }))
				expect(required.length).toBe(1)
				expect(required[0]).toContain(id)
				expect(required[0]).toContain("A run in flight during a deploy")

				// A Domain upgrade that changes the persisted __cause codec must fail the lock.
				const lockWithCause = lockWith({
					[id]: [
						{
							key: "sess_1:turn:1",
							session_id: "sess_1",
							agent_id: "agent_1",
							agent_version: 1,
							environment_id: "env_1",
							turn: 1,
							generation: 0,
							input: ["hi"],
							__cause: {
								correlationId: "corr_1",
								trace: { traceId: "trace_1", spanId: "span_1", sampled: true },
							},
						},
					],
				})
				expect(yield* lockProblems(lockWithCause)).toEqual([])
				const brokenCause = yield* lockProblems(
					lockWithCause,
					withInput({ __cause: Schema.optional(Schema.Struct({ correlationId: Schema.Number })) }),
				)
				expect(brokenCause.length).toBe(1)
				expect(brokenCause[0]).toContain(id)

				const optional = withInput({ added_later: Schema.optionalKey(Schema.Number) })
				const unreviewed = yield* lockProblems(lock, optional)
				expect(unreviewed.length).toBe(1)
				expect(unreviewed[0]).toContain("has not been reviewed")
				expect(yield* lockProblems(reviewing(lock, id, optional), optional)).toEqual([])
			}),
		))

	it("blocks a release that cannot deliver an already-armed turn deadline", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "scheduled-command:Sessions.Session/AbandonTurn"
				// The Durable Object stores this JSON as the alarm job's command.
				const lock = lockWith({
					[id]: [
						{
							_tag: "AbandonTurn",
							session_id: "session_deadline",
							turn: 3,
							error_type: "model_request_timeout",
							message: "Model request timed out.",
						},
					],
				})
				expect(yield* lockProblems(lock)).toEqual([])
				const missing = yield* shipBlockers(
					lock,
					persistedShapes.filter((shape) => shape.id !== id),
				)
				expect(missing).toEqual([expect.stringContaining(`${id} shipped`)])
				const changed = replacing(
					id,
					Schema.Struct({ ...AbandonTurn.fields, generation: Schema.Int }),
				)
				const narrowed = yield* shipBlockers(lock, changed)
				expect(narrowed).toEqual([expect.stringContaining(`${id} can no longer read`)])
			}),
		))

	it("blocks unreadable receipt replies from aggregates and decisions, including previously empty replies", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sessionReply = "command-reply:Sessions/SendUserMessage"
				const agentReply = "command-reply:Agents/CreateAgent"
				const emptyReply = "command-reply:Sessions/SendUserInterrupt"
				const shipped = lockWith({
					[sessionReply]: [{ turn: 1 }],
					[agentReply]: [{ version: 1, version_id: "aver_001_1" }],
					[emptyReply]: [null],
				})
				expect(yield* lockProblems(shipped)).toEqual([])

				const narrowed = yield* shipBlockers(
					shipped,
					replacing(sessionReply, Schema.Struct({ turn: Schema.String })),
				)
				expect(narrowed).toEqual([expect.stringContaining(`${sessionReply} can no longer read`)])
				const removed = yield* shipBlockers(shipped, replacing(agentReply, Schema.Null))
				expect(removed).toEqual([expect.stringContaining(`${agentReply} can no longer read`)])
				const added = yield* shipBlockers(
					shipped,
					replacing(emptyReply, Schema.Struct({ accepted: Schema.Boolean })),
				)
				expect(added).toEqual([expect.stringContaining(`${emptyReply} can no longer read`)])
			}),
		))

	it("rehearses adding a field to a shipped event", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "event:Sessions.Session/user.message"
				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }

				const required = yield* lockProblems(
					lock,
					replacing(id, Schema.Struct({ ...UserMessage.fields, added_later: Schema.Number })),
				)
				expect(required.length).toBe(1)
				expect(required[0]).toContain(id)
				expect(required[0]).toContain("Events are permanent")

				const defaulted = replacing(
					id,
					Schema.Struct({
						...UserMessage.fields,
						added_later: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
					}),
				)
				const unreviewed = yield* lockProblems(lock, defaulted)
				expect(unreviewed.length).toBe(1)
				expect(unreviewed[0]).toContain("has not been reviewed")
				expect(yield* lockProblems(reviewing(lock, id, defaulted), defaulted)).toEqual([])
			}),
		))

	it("rehearses changing a shipped aggregate state with a migration step", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "state:Agents.Agent"
				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }
				const AgentStateV2 = Schema.Struct({ ...AgentState.fields, tier: Schema.String })

				const migrated = replacing(
					id,
					versionedSnapshot({
						current: 2,
						schema: AgentStateV2,
						previous: [
							snapshotVersion({
								version: 1,
								schema: AgentState,
								migrate: (state) => ({ ...state, tier: "standard" }),
							}),
						],
					}),
				)
				expect(yield* lockProblems(reviewing(lock, id, migrated), migrated)).toEqual([])

				const inPlace = yield* lockProblems(
					lock,
					replacing(id, versionedSnapshot({ current: 2, schema: AgentStateV2 })),
				)
				expect(inPlace.length).toBe(1)
				expect(inPlace[0]).toContain(id)
				expect(inPlace[0]).toContain("Aggregate state is permanent")
			}),
		))

	it("reports a retired shape that is active again", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const event = shapeOfKind("event")
				const problems = yield* lockProblems({
					version: 1,
					retired: { [event.id]: "Replaced; no stream holds it." },
					reviewed: {},
					baselines: [],
				})
				expect(problems.length).toBe(1)
				expect(problems[0]).toContain(event.id)
				expect(problems[0]).toContain("a retired shape is active again")
			}),
		))

	it("lets a view change shape only when its version increased", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "view:Sessions.TurnInput@v1"
				expect(persistedShapes.map((shape) => shape.id)).toContain(id)
				const earlier = viewShapeId("Sessions", "TurnInput", 0)
				const later = viewShapeId("Sessions", "TurnInput", 2)

				expect(yield* lockProblems(lockWith({ [earlier]: [{ shape: "of v0" }] }))).toEqual([])

				const downgraded = yield* lockProblems(lockWith({ [later]: [{ shape: "of v2" }] }))
				expect(downgraded.length).toBe(1)
				expect(downgraded[0]).toContain("only ever increases")

				const stale = yield* lockProblems(lockWith({ [id]: [{ shape: "changed in place" }] }))
				expect(stale.length).toBe(1)
				expect(stale[0]).toContain("Bump the view's `version`")

				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const widened = replacing(
					id,
					Schema.NullOr(
						Schema.Struct({
							...TurnInputState.fields,
							derived: Schema.optionalKey(Schema.String),
						}),
					),
				)
				const sameVersion = yield* lockProblems(
					{ version: 1, retired: {}, reviewed: {}, baselines: [shipped] },
					widened,
				)
				expect(sameVersion.length).toBe(1)
				expect(sameVersion[0]).toContain("without a new version")
			}),
		))

	it("blocks a view version bump whose new state breaks queued policy deliveries", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const viewId = "view:Sessions.TurnInput@v1"
				const startDeliveryId = policyDeliveryShapeId("Sessions", "StartTurn", "TurnInput")
				const stopDeliveryId = policyDeliveryShapeId("Sessions", "StopModelRequest", "TurnInput")
				expect(persistedShapes.map((shape) => shape.id)).toEqual(
					expect.arrayContaining([viewId, startDeliveryId, stopDeliveryId]),
				)

				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }

				const upgradedTurnInput = (nextState: Schema.Top): ReadonlyArray<PersistedShape> =>
					persistedShapes.map((shape) => {
						if (shape.id === viewId) {
							return {
								...shape,
								id: viewShapeId("Sessions", "TurnInput", 2),
								schema: nextState as unknown as PersistedShape["schema"],
							}
						}
						if (shape.id === startDeliveryId || shape.id === stopDeliveryId) {
							return { ...shape, schema: nextState as unknown as PersistedShape["schema"] }
						}
						return shape
					})

				// Even with TurnInput bumped to v2, adding a required field breaks queued deliveries.
				const breaking = upgradedTurnInput(
					Schema.NullOr(Schema.Struct({ ...TurnInputState.fields, required_later: Schema.String })),
				)
				const breakingProblems = yield* lockProblems(lock, breaking)
				expect(breakingProblems.length).toBe(2)
				expect(breakingProblems).toEqual(
					expect.arrayContaining([
						expect.stringContaining(startDeliveryId),
						expect.stringContaining(stopDeliveryId),
					]),
				)
				expect(breakingProblems.every((p) => p.includes("Queued policy deliveries"))).toBe(true)

				// A backward-compatible optional field passes once both policy deliveries are reviewed.
				const compatible = upgradedTurnInput(
					Schema.NullOr(
						Schema.Struct({
							...TurnInputState.fields,
							optional_later: Schema.optionalKey(Schema.String),
						}),
					),
				)
				const unreviewed = yield* lockProblems(lock, compatible)
				expect(unreviewed.length).toBe(2)
				expect(unreviewed.every((p) => p.includes("has not been reviewed"))).toBe(true)

				const reviewedLock: PersistedLock = {
					...lock,
					reviewed: Object.fromEntries(
						[startDeliveryId, stopDeliveryId].map((id) => {
							const shape = compatible.find((candidate) => candidate.id === id)
							if (shape === undefined) throw new Error(`missing ${id}`)
							return [id, { schema: schemaFingerprint(shape), reason: "Optional field added." }]
						}),
					),
				}
				expect(yield* lockProblems(reviewedLock, compatible)).toEqual([])

				// A view with no policy consumers can still break shape freely on a version bump.
				const agentViewId = viewShapeId("Agents", "AgentView", 0)
				const upgradedAgentView = persistedShapes.map((shape) =>
					shape.id === agentViewId
						? {
								...shape,
								id: viewShapeId("Agents", "AgentView", 1),
								schema: Schema.NullOr(
									Schema.Struct({ rebuilt_v1: Schema.String }),
								) as unknown as PersistedShape["schema"],
							}
						: shape,
				)
				expect(yield* lockProblems(lock, upgradedAgentView)).toEqual([])
			}),
		))

	it("derives the activity lock from the steps RunTurn executes", () => {
		const steps = persistedShapes
			.filter((shape) => shape.kind === "saga-step")
			.map((shape) => shape.id)
		const declared = Object.values(RUN_TURN_ACTIVITIES).map(
			(activity) => `saga-step:Sessions.RunTurn/${activity.name}`,
		)
		expect(steps.toSorted()).toEqual(declared.toSorted())

		// Guard against adding or renaming an Activity.make call in RunTurn without RUN_TURN_ACTIVITIES.
		const runTurnSource = readFileSync(
			new URL("../../../packages/sessions/src/Session/RunTurn.saga.ts", import.meta.url),
			"utf8",
		)
		const activityCalls = [...runTurnSource.matchAll(/Activity\.make\(\{([\s\S]*?)\}\)/g)]
		expect(activityCalls.length).toBe(Object.keys(RUN_TURN_ACTIVITIES).length)
		const referencedKeys = activityCalls.flatMap((match) => {
			const ref = /\.\.\.RUN_TURN_ACTIVITIES\.([A-Za-z0-9_]+)/.exec(match[1] ?? "")
			return ref?.[1] === undefined ? [] : [ref[1]]
		})
		expect(referencedKeys.toSorted()).toEqual(Object.keys(RUN_TURN_ACTIVITIES).toSorted())
	})

	it("locks a saga's completed result", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const id = "saga-result:Sessions.RunTurn"
				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const changed = persistedShapes.map((shape) =>
					shape.id === id
						? {
								...shape,
								schema: Schema.Struct({
									outcome: Schema.String,
								}) as unknown as PersistedShape["schema"],
							}
						: shape,
				)
				const problems = yield* lockProblems(
					{ version: 1, retired: {}, reviewed: {}, baselines: [shipped] },
					changed,
				)
				expect(problems.length).toBe(1)
				expect(problems[0]).toContain(id)
				expect(problems[0]).toContain("A completed run keeps its result")
			}),
		))

	it("blocks a production deploy until a baseline covers the current shapes", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				expect(
					yield* shipBlockers({ version: 1, retired: {}, reviewed: {}, baselines: [] }),
				).toEqual(["No baseline has been cut yet."])

				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }
				expect(yield* shipBlockers(lock)).toEqual([])

				const added: PersistedShape = {
					id: "event:Sessions.session.example_added",
					kind: "event",
					schema: Schema.Struct({ note: Schema.String }) as unknown as PersistedShape["schema"],
				}
				expect(yield* shipBlockers(lock, [...persistedShapes, added])).toEqual([
					'Persisted shapes changed since "shipped".',
				])
			}),
		))

	it("treats a schema change as a change even when every sample is identical", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const shape = shapeOfKind("event")
				const narrowed = (schema: Schema.Top): PersistedShape => ({
					...shape,
					schema: schema as unknown as PersistedShape["schema"],
				})
				expect(
					schemaFingerprint(narrowed(Schema.Struct({ status: Schema.Literals(["a", "b"]) }))),
				).not.toBe(schemaFingerprint(narrowed(Schema.Struct({ status: Schema.Literals(["a"]) }))))

				const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
				const sameSamples: PersistedLock = {
					version: 1,
					retired: {},
					reviewed: {},
					baselines: [
						{ ...shipped, schemas: { ...shipped.schemas, [shape.id]: "an older schema" } },
					],
				}
				const blockers = yield* shipBlockers(sameSamples)
				expect(blockers.length).toBe(1)
				expect(blockers[0]).toContain(shape.id)
				expect(blockers[0]).toContain("has not been reviewed")
			}),
		))
})
