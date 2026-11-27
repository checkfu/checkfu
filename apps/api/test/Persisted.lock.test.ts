import { AbandonTurn } from "@checkfu/domain/Session/AbandonTurn.command"
import { RUN_TURN_ACTIVITIES, RunTurn } from "@checkfu/domain/Session/RunTurn.saga"
import { UserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { NonNegativeInt } from "@checkfu/domain/Session/SessionTypes"
import { TurnInput, TurnInputState } from "@checkfu/domain/Session/TurnInput.view"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { DocumentId, JsonObject } from "@earendil-works/pi-durable"
import { expect, it } from "@effect/vitest"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ArtifactLinkClaims, linkKey, signLink } from "../src/Content/ArtifactLink.ts"
import { createPiModels } from "../src/Pi/PiModels.ts"
import { CHECKFU_PI_DOCS, SettledUsage, SettledUsageState } from "../src/Pi/PiTurnUsage.ts"
import { FanoutPagePayload } from "../src/Webhooks/FanoutPayloads.ts"
import { createInMemoryPiDurableBackend } from "./helpers/InMemoryPiBackend.ts"
import {
	PersistedServicesLive,
	cutBaseline,
	decodeFailure,
	lockProblems,
	readLockFile,
	sampleEncoded,
	schemaFingerprint,
	shipBlockers,
} from "./persisted/Lock.ts"
import type { PersistedLock } from "./persisted/Lock.ts"
import {
	persistedShapes,
	piDocPersistedSchema,
	piDocShapeId,
	policyDeliveryShapeId,
	registryProblems,
	viewShapeId,
} from "./persisted/Shapes.ts"
import type { PersistedShape } from "./persisted/Shapes.ts"

const shapeOfKind = (kind: PersistedShape["kind"]): PersistedShape => {
	const shape = persistedShapes.find((candidate) => candidate.kind === kind)
	if (shape === undefined) {
		throw new Error(`no ${kind} shape is registered`)
	}
	return shape
}

const replacing = (id: string, schema: Schema.Top): ReadonlyArray<PersistedShape> => {
	expect(persistedShapes.map((shape) => shape.id)).toContain(id)
	return persistedShapes.map((shape) =>
		shape.id === id ? { ...shape, schema: schema as unknown as PersistedShape["schema"] } : shape,
	)
}

const reviewing = (lock: PersistedLock, id: string, shapes: ReadonlyArray<PersistedShape>) =>
	Effect.gen(function* () {
		const shape = shapes.find((candidate) => candidate.id === id)
		if (shape === undefined) {
			throw new Error(`no shape ${id}`)
		}
		return {
			...lock,
			reviewed: { [id]: { schema: yield* schemaFingerprint(shape), reason: "Checked in a test." } },
		} satisfies PersistedLock
	})

const lockWith = (
	shapes: Record<string, ReadonlyArray<unknown>>,
	retired: Record<string, string> = {},
): PersistedLock => ({
	version: 1,
	retired,
	reviewed: {},
	baselines: [{ label: "test-baseline", cut_at: "2026-01-01T00:00:00.000Z", schemas: {}, shapes }],
})

it.layer(PersistedServicesLive, { excludeTestServices: true })("persisted shapes", (it) => {
	it.effect(
		"finds every event, state, view, saga, and Pi document shape the hosted models declare",
		() =>
			Effect.sync(() => {
				expect(registryProblems()).toEqual([])
				expect(persistedShapes.filter((shape) => shape.kind === "state").length).toBe(16)
				expect(persistedShapes.map((shape) => shape.id)).toEqual(
					expect.arrayContaining([
						"saga-input:Checkfu.RunTurn",
						"command-reply:Checkfu/AdmitSession",
						"state:Checkfu.Automation",
						"event:Checkfu.Automation/automation.fired",
						"scheduled-command:Checkfu.Automation/FireAutomation",
						"command-reply:Checkfu/RunAutomation",
						"command-reply:Checkfu/AdmitAutomation",
						"state:Checkfu.AutomationCapacity",
						"state:Checkfu.SystemContext",
						"event:Checkfu.SystemContext/system_context.appended",
						"event:Checkfu.AutomationCapacity/automation_slot.reserved",
						"event:Checkfu.Session/idempotency_key.claimed",
						"command-reply:Checkfu/ClaimIdempotencyKey",
						"state:Webhooks.WebhookEndpoint",
						"event:Webhooks.WebhookEndpoint/webhook.created",
						"scheduled-command:Webhooks.WebhookEndpoint/ExpirePreviousWebhookSecret",
						"webhook-table:webhook_deliveries",
						"state:Vaults.Vault",
						"state:Vaults.Credential",
						"state:Vaults.CredentialUrlClaim",
						"event:Vaults.CredentialUrlClaim/vault_credential_url.claimed",
						"event:Vaults.Vault/vault.credential_released",
						"event:Vaults.Credential/vault_credential.secret_erased",
						"event:Vaults.Vault/vault.credential_attached",
						"event:Vaults.Credential/vault_credential.created",
						"command-reply:Vaults/CreateCredential",
						"view:Vaults.CredentialView@v0",
						"state:Checkfu.MemoryStore",
						"state:Checkfu.Memory",
						"event:Checkfu.Memory/memory.written",
						"event:Checkfu.MemoryStore/memory_store.memory_added",
						"command-reply:Checkfu/WriteMemory",
						"pi-doc:checkfu.active-usage",
						"pi-doc:checkfu.settled-usage",
						"pi-doc:checkfu.session-system-context",
					]),
				)
			}),
	)

	it.effect("writes every shape in a JSON form the same code reads back", () =>
		Effect.gen(function* () {
			const unreadable: Array<string> = []
			for (const shape of persistedShapes) {
				const samples = yield* sampleEncoded(shape, 4)
				if (samples.length !== 4) {
					unreadable.push(`${shape.id}: ${samples.length} samples`)
				}
				for (const sample of samples) {
					const failure = yield* decodeFailure(shape, sample)
					if (failure !== null) {
						unreadable.push(`${shape.id}: ${failure}`)
					}
				}
			}
			expect(unreadable).toEqual([])
		}),
	)

	it.effect("still reads everything written by every shipped baseline", () =>
		Effect.gen(function* () {
			const lock = yield* readLockFile
			expect(yield* lockProblems(lock)).toEqual([])
		}),
	)
})

it.layer(PersistedServicesLive, { excludeTestServices: true })("persisted shape lock", (it) => {
	it.effect("accepts a baseline cut from the current code", () =>
		Effect.gen(function* () {
			const baseline = yield* cutBaseline("now", "2026-01-01T00:00:00.000Z")
			expect(Object.keys(baseline.shapes).length).toBe(persistedShapes.length)
			expect(
				yield* lockProblems({ version: 1, retired: {}, reviewed: {}, baselines: [baseline] }),
			).toEqual([])
		}),
	)

	it.effect("reports a shipped value the current schema can no longer read, with the rule", () =>
		Effect.gen(function* () {
			const event = shapeOfKind("event")
			const problems = yield* lockProblems(lockWith({ [event.id]: [{ not: "this event" }] }))
			expect(problems.length).toBe(1)
			expect(problems[0]).toContain(event.id)
			expect(problems[0]).toContain('baseline "test-baseline"')
			expect(problems[0]).toContain("Events are permanent")
		}),
	)

	it.effect("reports a shipped shape nothing reads any more, unless it is retired", () =>
		Effect.gen(function* () {
			const gone = "event:Sessions.Session/removed.event"
			const dropped = yield* lockProblems(lockWith({ [gone]: [{}] }))
			expect(dropped.length).toBe(1)
			expect(dropped[0]).toContain(gone)
			expect(dropped[0]).toContain('"retired"')

			const retired = yield* lockProblems(
				lockWith({ [gone]: [{}] }, { [gone]: "Replaced by removed.event_v2; no stream holds it." }),
			)
			expect(retired).toEqual([])
		}),
	)

	it.effect(
		"fails a saga input that gains a required field or breaks __cause, and passes an optional one",
		() =>
			Effect.gen(function* () {
				const id = "saga-input:Checkfu.RunTurn"
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

				const required = yield* lockProblems(lock, withInput({ added_later: Schema.Finite }))
				expect(required.length).toBe(1)
				expect(required[0]).toContain(id)
				expect(required[0]).toContain("A run in flight during a deploy")

				const lockWithCause = lockWith({
					[id]: [
						{
							key: "sess_1:turn:1",
							session_id: "sess_1",
							agent_id: "agent_1",
							agent_version: 1,
							environment_id: "env_1",
							resources: [],
							turn: 1,
							last_reply_turn: 0,
							segment: 1,
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
					withInput({ __cause: Schema.optional(Schema.Struct({ correlationId: Schema.Finite })) }),
				)
				expect(brokenCause.length).toBe(1)
				expect(brokenCause[0]).toContain(id)

				const optional = withInput({ added_later: Schema.optionalKey(Schema.Finite) })
				const unreviewed = yield* lockProblems(lock, optional)
				expect(unreviewed.length).toBe(1)
				expect(unreviewed[0]).toContain("has not been reviewed")
				expect(yield* lockProblems(yield* reviewing(lock, id, optional), optional)).toEqual([])
			}),
	)

	it.effect("blocks a release that cannot deliver an already-armed turn deadline", () =>
		Effect.gen(function* () {
			const id = "scheduled-command:Checkfu.Session/AbandonTurn"

			const lock = lockWith({
				[id]: [
					{
						_tag: "AbandonTurn",
						session_id: "session_deadline",
						turn: 3,
						segment: 1,
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
			const changed = replacing(id, Schema.Struct({ ...AbandonTurn.fields, attempt: Schema.Int }))
			const narrowed = yield* shipBlockers(lock, changed)
			expect(narrowed).toEqual([expect.stringContaining(`${id} can no longer read`)])
		}),
	)

	it.effect("tracks the payloads of all scheduled webhook fan-out callbacks", () =>
		Effect.gen(function* () {
			const pageId = "webhook-callback:WebhookFanout/fanoutPage"
			const retryId = "webhook-callback:WebhookFanout/retrySubscriber"
			const cleanupId = "webhook-callback:WebhookFanout/cleanup"
			const page = {
				event: {
					event_id: "evt_automation_run_arun_fixture_1",
					event_type: "automation_run.started",
					resource_type: "automation_run",
					resource_id: "arun_fixture",
					occurred_at: 1_764_000_000_000,
					automation_id: "auto_fixture",
				},
				cursor: "1763999999000:whe_previous",
				step: 2,
			}
			const retry = {
				event: {
					event_id: "evt_vault_credential_vc_fixture_1",
					event_type: "vault_credential.created",
					resource_type: "vault_credential",
					resource_id: "vc_fixture",
					occurred_at: 1_764_000_000_000,
					vault_id: "vlt_fixture",
				},
				webhookId: "whe_fixture",
			}
			const cleanup = { eventId: page.event.event_id }
			const callbacks = persistedShapes.filter(({ kind }) => kind === "webhook-callback")
			expect(callbacks.map(({ id }) => id)).toEqual([pageId, retryId, cleanupId])
			expect(
				registryProblems(persistedShapes.filter(({ kind }) => kind !== "webhook-callback")),
			).toEqual(["no webhook-callback shape was found"])
			const baseline = yield* cutBaseline(
				"fan-out callbacks",
				"2026-01-01T00:00:00.000Z",
				callbacks,
			)
			const lock: PersistedLock = {
				version: 1,
				retired: {},
				reviewed: {},
				baselines: [
					{
						...baseline,
						shapes: { [pageId]: [page], [retryId]: [retry], [cleanupId]: [cleanup] },
					},
				],
			}
			expect(yield* lockProblems(lock)).toEqual([])
			const removed = persistedShapes.filter(({ id }) => id !== retryId)
			expect(yield* shipBlockers(lock, removed)).toEqual([
				expect.stringContaining(`${retryId} shipped`),
			])
			const narrowed = replacing(
				pageId,
				Schema.Struct({ ...FanoutPagePayload.fields, attempt: Schema.Int }),
			)
			expect(yield* shipBlockers(lock, narrowed)).toEqual([
				expect.stringContaining(`${pageId} can no longer read`),
			])
			const withAttempt = Schema.Struct({
				...FanoutPagePayload.fields,
				attempt: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
			})
			const additive = replacing(pageId, withAttempt)
			expect(yield* Schema.decodeUnknownEffect(withAttempt)(page)).toEqual({ ...page, attempt: 0 })
			expect(yield* lockProblems(lock, additive)).toEqual([
				expect.stringContaining("has not been reviewed"),
			])
			expect(yield* lockProblems(yield* reviewing(lock, pageId, additive), additive)).toEqual([])
		}),
	)

	it.effect(
		"blocks unreadable receipt replies from aggregates and decisions, including previously empty replies",
		() =>
			Effect.gen(function* () {
				const sessionReply = "command-reply:Checkfu/SendUserMessage"
				const agentReply = "command-reply:Checkfu/CreateAgent"
				const emptyReply = "command-reply:Checkfu/SendUserInterrupt"
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
	)

	it.effect("rehearses adding a field to a shipped event", () =>
		Effect.gen(function* () {
			const id = "event:Checkfu.Session/user.message"
			const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
			const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }

			const required = yield* lockProblems(
				lock,
				replacing(id, Schema.Struct({ ...UserMessage.fields, added_later: Schema.Finite })),
			)
			expect(required.length).toBe(1)
			expect(required[0]).toContain(id)
			expect(required[0]).toContain("Events are permanent")

			const defaulted = replacing(
				id,
				Schema.Struct({
					...UserMessage.fields,
					added_later: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
				}),
			)
			const unreviewed = yield* lockProblems(lock, defaulted)
			expect(unreviewed.length).toBe(1)
			expect(unreviewed[0]).toContain("has not been reviewed")
			expect(yield* lockProblems(yield* reviewing(lock, id, defaulted), defaulted)).toEqual([])
		}),
	)

	it.effect("reports a retired shape that is active again", () =>
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
	)

	it.effect(
		"locks the name of every policy an aggregate feeds, so a renamed policy is caught",
		() =>
			Effect.gen(function* () {
				expect(persistedShapes.map((shape) => shape.id)).toEqual(
					expect.arrayContaining([
						"policy-delivery:Checkfu.SaveSessionOutputs/Session",
						"policy-delivery:Checkfu.ReleaseArtifactBytes/Artifact",
					]),
				)
				const renamed = "policy-delivery:Checkfu.DiscardWorkspace/Session"
				expect(persistedShapes.map((shape) => shape.id)).not.toContain(renamed)
				expect(yield* lockProblems(lockWith({ [renamed]: [] }))).toEqual([
					expect.stringContaining(
						`${renamed} shipped in baseline "test-baseline" and nothing reads it now.`,
					),
				])
			}),
	)

	it.effect("locks the arguments and the result of every call between the Workers", () =>
		Effect.gen(function* () {
			expect(
				persistedShapes
					.filter((shape) => shape.kind === "harness-call")
					.map((shape) => shape.id)
					.toSorted(),
			).toEqual(
				[
					"abortTurn",
					"answerCall",
					"customToolFaults",
					"discardWorkspace",
					"eraseSecret",
					"interruptWorkspace",
					"listOutputs",
					"pauseUsage",
					"prepareWorkspace",
					"putSecret",
					"readOutputs",
					"readSkill",
					"recoverTurn",
					"runTurn",
					"sealVault",
					"secretUsable",
					"storeRepositoryToken",
				]
					.flatMap((method) => [
						`harness-call:PiHarness.${method}/args`,
						`harness-call:PiHarness.${method}/result`,
					])
					.toSorted(),
			)
			const id = "harness-call:PiHarness.abortTurn/args"
			const sent = lockWith({ [id]: [["sess_1", "turn:1"]] })
			expect(yield* lockProblems(sent)).toEqual([])
			const reshaped = yield* lockProblems(
				sent,
				replacing(
					id,
					Schema.Tuple([
						Schema.Struct({ conversation: Schema.String, operationId: Schema.String }),
					]),
				),
			)
			expect(reshaped.length).toBe(1)
			expect(reshaped[0]).toContain(id)
		}),
	)

	it.effect("locks the artifact files in R2 and the marks each owner object keeps", () =>
		Effect.gen(function* () {
			const idsOf = (kind: PersistedShape["kind"]) =>
				persistedShapes
					.filter((shape) => shape.kind === kind)
					.map((shape) => shape.id)
					.toSorted()
			expect(idsOf("artifact-object")).toEqual(["artifact-object:manifest"])
			expect(idsOf("artifact-marks")).toEqual([
				"artifact-marks:ArtifactObjects/marks",
				"artifact-marks:FileObjects/marks",
			])
			const manifest = "artifact-object:manifest"
			const written = lockWith({
				[manifest]: [
					{
						files: [{ path: "a.txt", sha256: "0".repeat(64), size: 1, content_type: "text/plain" }],
					},
				],
			})
			expect(yield* lockProblems(written)).toEqual([])
			const renamed = yield* lockProblems(
				written,
				replacing(
					manifest,
					Schema.Struct({ entries: Schema.Array(Schema.Struct({ path: Schema.String })) }),
				),
			)
			expect(renamed.length).toBe(1)
			expect(renamed[0]).toContain(manifest)
			expect(renamed[0]).toContain("Artifact manifests")
			const marks = "artifact-marks:ArtifactObjects/marks"
			const kept = lockWith({ [marks]: [{ purged: true, staged: 2, released: 1 }] })
			expect(yield* lockProblems(kept)).toEqual([])
			const reshaped = yield* lockProblems(
				kept,
				replacing(marks, Schema.Struct({ deleted: Schema.Boolean })),
			)
			expect(reshaped.length).toBe(1)
			expect(reshaped[0]).toContain("artifact owner object")
		}),
	)

	it.effect("locks viewing link claims and every call another Worker makes to the API", () =>
		Effect.gen(function* () {
			const idsOf = (kind: PersistedShape["kind"]) =>
				persistedShapes
					.filter((shape) => shape.kind === kind)
					.map((shape) => shape.id)
					.toSorted()
			expect(idsOf("signed-link")).toEqual(["signed-link:ArtifactLink/claims"])
			expect(idsOf("api-call")).toEqual(
				[
					"api-call:Api.artifactData/args",
					"api-call:Api.artifactData/error",
					"api-call:Api.artifactData/result",
					"api-call:Api.resolveArtifactVersion/args",
					"api-call:Api.resolveArtifactVersion/error",
					"api-call:Api.resolveArtifactVersion/result",
					"api-call:Api.resolvePublication/args",
					"api-call:Api.resolvePublication/error",
					"api-call:Api.resolvePublication/result",
					...[
						"artifactFiles",
						"artifactMounts",
						"artifactRead",
						"memoryList",
						"memoryMounts",
						"memoryRead",
						"memoryRemove",
						"memoryStat",
						"memoryWrite",
						"sessionArtifactData",
						"sessionArtifactSave",
						"sessionFileSave",
					].flatMap((method) => [`api-call:Api.${method}/args`, `api-call:Api.${method}/result`]),
				].toSorted(),
			)
			const claims = "signed-link:ArtifactLink/claims"
			const signed = lockWith({ [claims]: ["default.art_1.1.1800000000.read"] })
			expect(yield* lockProblems(signed)).toEqual([])
			const shape = persistedShapes.find((candidate) => candidate.id === claims)
			const mac = yield* Mac.Mac
			const key = yield* Effect.orDie(linkKey("lock"))
			for (const sample of yield* Effect.orDie(sampleEncoded(shape as PersistedShape))) {
				const decoded = yield* Effect.orDie(Schema.decodeUnknownEffect(ArtifactLinkClaims)(sample))
				const [carried = ""] = (yield* signLink(mac, key, decoded)).split(".")
				expect(Result.getOrUndefined(Base64Url.decodeString(carried))).toBe(sample)
			}
			const reshaped = yield* lockProblems(
				signed,
				replacing(
					claims,
					Schema.Struct({
						scope: Schema.String,
						artifactId: Schema.String,
						manifest: Schema.String,
					}),
				),
			)
			expect(reshaped.length).toBe(1)
			expect(reshaped[0]).toContain(claims)
			expect(reshaped[0]).toContain("viewing link")
			const args = "api-call:Api.resolveArtifactVersion/args"
			const sent = lockWith({ [args]: [["art_1", 2]] })
			expect(yield* lockProblems(sent)).toEqual([])
			const changed = yield* lockProblems(
				sent,
				replacing(args, Schema.Tuple([Schema.Struct({ artifactId: Schema.String })])),
			)
			expect(changed.length).toBe(1)
			expect(changed[0]).toContain("content Worker and the API Worker")
			for (const method of ["resolveArtifactVersion", "resolvePublication"]) {
				const error = `api-call:Api.${method}/error`
				const failed = lockWith({
					[error]: [{ _tag: "ArtifactVersionNotReady", artifactId: "art_1", version: 2 }],
				})
				expect(yield* lockProblems(failed)).toEqual([])
				const refailed = yield* lockProblems(
					failed,
					replacing(
						error,
						Schema.TaggedStruct("ArtifactVersionNotReady", { artifact_id: Schema.String }),
					),
				)
				expect(refailed.length).toBe(1)
				expect(refailed[0]).toContain(error)
			}
		}).pipe(Effect.provide(Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)))),
	)

	it.effect("lets a view change shape only when its version increased", () =>
		Effect.gen(function* () {
			const id = viewShapeId("Checkfu", "TurnInput", TurnInput.definition.version ?? 0)
			expect(persistedShapes.map((shape) => shape.id)).toContain(id)
			const earlier = viewShapeId("Checkfu", "TurnInput", 0)
			const later = viewShapeId("Checkfu", "TurnInput", (TurnInput.definition.version ?? 0) + 1)

			expect(yield* lockProblems(lockWith({ [earlier]: [{ shape: "of v0" }] }))).toEqual([])

			const downgraded = yield* lockProblems(lockWith({ [later]: [{ shape: "of v5" }] }))
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
	)

	it.effect("blocks a view version bump whose new state breaks queued policy deliveries", () =>
		Effect.gen(function* () {
			const viewId = viewShapeId("Checkfu", "TurnInput", TurnInput.definition.version ?? 0)
			const startDeliveryId = policyDeliveryShapeId("Checkfu", "StartTurn", "TurnInput")
			expect(persistedShapes.map((shape) => shape.id)).toEqual(
				expect.arrayContaining([viewId, startDeliveryId]),
			)

			const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
			const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }

			const upgradedTurnInput = (nextState: Schema.Top): ReadonlyArray<PersistedShape> =>
				persistedShapes.map((shape) => {
					if (shape.id === viewId) {
						return {
							...shape,
							id: viewShapeId("Checkfu", "TurnInput", (TurnInput.definition.version ?? 0) + 1),
							schema: nextState as unknown as PersistedShape["schema"],
						}
					}
					if (shape.id === startDeliveryId) {
						return { ...shape, schema: nextState as unknown as PersistedShape["schema"] }
					}
					return shape
				})

			const breaking = upgradedTurnInput(
				Schema.NullOr(Schema.Struct({ ...TurnInputState.fields, required_later: Schema.String })),
			)
			const breakingProblems = yield* lockProblems(lock, breaking)
			expect(breakingProblems.length).toBe(1)
			expect(breakingProblems).toEqual([expect.stringContaining(startDeliveryId)])
			expect(breakingProblems.every((p) => p.includes("Queued policy deliveries"))).toBe(true)

			const compatible = upgradedTurnInput(
				Schema.NullOr(
					Schema.Struct({
						...TurnInputState.fields,
						optional_later: Schema.optionalKey(Schema.String),
					}),
				),
			)
			const unreviewed = yield* lockProblems(lock, compatible)
			expect(unreviewed.length).toBe(1)
			expect(unreviewed.every((p) => p.includes("has not been reviewed"))).toBe(true)

			const reviewedEntries = yield* Effect.forEach([startDeliveryId], (id) =>
				Effect.gen(function* () {
					const shape = compatible.find((candidate) => candidate.id === id)
					if (shape === undefined) {
						throw new Error(`missing ${id}`)
					}
					return [
						id,
						{ schema: yield* schemaFingerprint(shape), reason: "Optional field added." },
					] as const
				}),
			)
			const reviewedLock: PersistedLock = {
				...lock,
				reviewed: Object.fromEntries(reviewedEntries),
			}
			expect(yield* lockProblems(reviewedLock, compatible)).toEqual([])

			const agentViewId = viewShapeId("Checkfu", "AgentView", 0)
			const upgradedAgentView = persistedShapes.map((shape) =>
				shape.id === agentViewId
					? {
							...shape,
							id: viewShapeId("Checkfu", "AgentView", 1),
							schema: Schema.NullOr(Schema.Struct({ rebuilt_v1: Schema.String })),
						}
					: shape,
			)
			expect(yield* lockProblems(lock, upgradedAgentView)).toEqual([])
		}),
	)

	it.effect("derives the activity lock from the steps RunTurn executes", () =>
		Effect.sync(() => {
			const steps = persistedShapes
				.filter((shape) => shape.kind === "saga-step")
				.map((shape) => shape.id)
			const declared = Object.values(RUN_TURN_ACTIVITIES).map(
				(activity) => `saga-step:Checkfu.RunTurn/${activity.name}`,
			)
			expect(steps.toSorted()).toEqual(declared.toSorted())
		}),
	)

	it.effect("locks a saga's completed result", () =>
		Effect.gen(function* () {
			const id = "saga-result:Checkfu.RunTurn"
			const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
			const changed = persistedShapes.map((shape) =>
				shape.id === id
					? {
							...shape,
							schema: Schema.Struct({
								outcome: Schema.String,
							}),
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
	)

	it.effect("blocks a production deploy until a baseline covers the current shapes", () =>
		Effect.gen(function* () {
			expect(yield* shipBlockers({ version: 1, retired: {}, reviewed: {}, baselines: [] })).toEqual(
				["No baseline has been cut yet."],
			)

			const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
			const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }
			expect(yield* shipBlockers(lock)).toEqual([])

			const added: PersistedShape = {
				id: "event:Sessions.session.example_added",
				kind: "event",
				schema: Schema.Struct({ note: Schema.String }),
			}
			expect(yield* shipBlockers(lock, [...persistedShapes, added])).toEqual([
				'Persisted shapes changed since "shipped".',
			])
		}),
	)

	it.effect("treats a schema change as a change even when every sample is identical", () =>
		Effect.gen(function* () {
			const shape = shapeOfKind("event")
			const narrowed = (schema: Schema.Top): PersistedShape => ({
				...shape,
				schema: schema as unknown as PersistedShape["schema"],
			})
			expect(
				yield* schemaFingerprint(narrowed(Schema.Struct({ status: Schema.Literals(["a", "b"]) }))),
			).not.toBe(
				yield* schemaFingerprint(narrowed(Schema.Struct({ status: Schema.Literals(["a"]) }))),
			)

			const shipped = yield* cutBaseline("shipped", "2026-01-01T00:00:00.000Z")
			const sameSamples: PersistedLock = {
				version: 1,
				retired: {},
				reviewed: {},
				baselines: [{ ...shipped, schemas: { ...shipped.schemas, [shape.id]: "an older schema" } }],
			}
			const blockers = yield* shipBlockers(sameSamples)
			expect(blockers.length).toBe(1)
			expect(blockers[0]).toContain(shape.id)
			expect(blockers[0]).toContain("has not been reviewed")
		}),
	)

	it.effect(
		"locks every Checkfu Pi document in CHECKFU_PI_DOCS independent of import order and rejects unregistered persisted docs at runtime",
		() =>
			Effect.gen(function* () {
				const registered = persistedShapes
					.filter((shape) => shape.kind === "pi-doc")
					.map((shape) => shape.id)
				const declaredBeforeWorkerImport = CHECKFU_PI_DOCS.map((spec) =>
					piDocShapeId(spec.token.definition.kind),
				)
				expect(Object.isFrozen(CHECKFU_PI_DOCS)).toBe(true)
				expect(registered.toSorted()).toEqual(declaredBeforeWorkerImport.toSorted())
				expect(new Set(declaredBeforeWorkerImport).size).toBe(declaredBeforeWorkerImport.length)

				yield* Effect.promise(() => import("../src/Pi/PiHarnessWorker.ts"))
				const declaredAfterWorkerImport = CHECKFU_PI_DOCS.map((spec) =>
					piDocShapeId(spec.token.definition.kind),
				)
				expect(declaredAfterWorkerImport).toEqual(declaredBeforeWorkerImport)
				expect(registered.toSorted()).toEqual(declaredAfterWorkerImport.toSorted())

				const backend = yield* Effect.acquireRelease(
					Effect.promise(() =>
						createInMemoryPiDurableBackend(
							createPiModels({ openai: Redacted.make("sk-test"), anthropic: null }),
						),
					),
					(b) => Effect.promise(() => b.close()),
				)
				yield* Effect.promise(() =>
					expect(
						backend.storage.commit(
							[
								[
									{
										type: "document.create",
										record: {
											id: 9999 as DocumentId,
											kind: "checkfu.unregistered-secret-doc",
											scope: { kind: "session" },
										},
										content: { kind: "base", version: 1, value: { ok: true } },
									},
								],
							],
							() => undefined,
							BACKGROUND_CONTEXT,
						),
					).rejects.toThrow(/Unregistered Pi durable document/),
				)
			}),

		30_000,
	)

	it.effect(
		"blocks incompatible changes to Checkfu-owned Pi documents unless versioned with a working migration",
		() =>
			Effect.gen(function* () {
				const id = piDocShapeId(SettledUsage.definition.kind)
				// Scope this migration fixture to the document whose versions change below.
				const shipped = yield* cutBaseline(
					"shipped",
					"2026-01-01T00:00:00.000Z",
					persistedShapes.filter((shape) => shape.id === id),
				)
				const lock: PersistedLock = { version: 1, retired: {}, reviewed: {}, baselines: [shipped] }

				const SettledUsageV2 = Schema.Struct({
					prompt_tokens: NonNegativeInt,
					output_tokens: NonNegativeInt,
				})

				const renamedInPlace = replacing(
					id,
					piDocPersistedSchema({
						token: SettledUsage,
						schema: SettledUsageV2,
					}),
				)
				const inPlaceBlockers = yield* shipBlockers(lock, renamedInPlace)
				expect(inPlaceBlockers).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])
				expect(inPlaceBlockers[0]).toContain("Pi durable documents survive deployments")

				const unmigratedV2 = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: { ...SettledUsage.definition, version: 2 },
						},
						schema: SettledUsageV2,
					}),
				)
				expect(yield* shipBlockers(lock, unmigratedV2)).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])

				const brokenMigrate = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => value,
							},
						},
						schema: SettledUsageV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					}),
				)
				expect(yield* shipBlockers(lock, brokenMigrate)).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])

				const changedFamily = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								kind: SettledUsage.definition.kind,
								version: SettledUsage.definition.version,
								scope: SettledUsage.definition.scope,
							},
						},
						schema: SettledUsageState,
					}),
				)
				expect(yield* shipBlockers(lock, changedFamily)).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])

				const migratedV2 = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									output_tokens: value.output_tokens ?? 0,
								}),
							},
						},
						schema: SettledUsageV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					}),
				)
				const unreviewed = yield* lockProblems(lock, migratedV2)
				expect(unreviewed.length).toBe(1)
				expect(unreviewed[0]).toContain("has not been reviewed")
				expect(yield* lockProblems(yield* reviewing(lock, id, migratedV2), migratedV2)).toEqual([])

				const V1WithTransformAndDefault = Schema.Struct({
					input_tokens: NonNegativeInt,
					output_tokens: NonNegativeInt,
					count: Schema.FiniteFromString,
					defaulted_weight: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(42))),
				})
				const v1Shape: PersistedShape = {
					id,
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: SettledUsage,
						schema: V1WithTransformAndDefault,
					}),
				}
				const v1StoredSample = {
					version: 1,
					scope: "session",
					family: true,
					value: {
						input_tokens: 10,
						output_tokens: 5,
						count: 7,
						defaulted_weight: 42,
					},
				}
				expect(yield* decodeFailure(v1Shape, v1StoredSample)).toBeNull()
				const cutV1Samples = yield* sampleEncoded(v1Shape, 4)
				const v1CutLock = lockWith({ [id]: [v1StoredSample, ...cutV1Samples] })

				const identityV2 = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => value,
							},
						},
						schema: V1WithTransformAndDefault,
						previous: [{ version: 1, schema: V1WithTransformAndDefault }],
					}),
				)
				expect(yield* lockProblems(v1CutLock, identityV2)).toEqual([])

				const V1OptionalString = Schema.Struct({
					input_tokens: NonNegativeInt,
					output_tokens: NonNegativeInt,
					count_str: Schema.String,
					optional_weight: Schema.optionalKey(NonNegativeInt),
				})
				const NewDocV2 = Schema.Struct({
					prompt_tokens: NonNegativeInt,
					output_tokens: NonNegativeInt,
					count: NonNegativeInt,
					weight: NonNegativeInt,
				})
				const rawV1Lock = lockWith({
					[id]: [
						{
							version: 1,
							scope: "session",
							family: true,
							value: {
								input_tokens: 10,
								output_tokens: 5,
								count_str: "7",
							},
						},
					],
				})
				const assumesMutated = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									output_tokens: value.output_tokens ?? 0,
									count: value.count_str ?? 0,
									weight: value.optional_weight ?? -1,
								}),
							},
						},
						schema: NewDocV2,
						previous: [{ version: 1, schema: V1OptionalString }],
					}),
				)
				expect(yield* shipBlockers(rawV1Lock, assumesMutated)).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])
				const handlesRawJson = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									output_tokens: value.output_tokens ?? 0,
									count: Number(value.count_str),
									weight: typeof value.optional_weight === "number" ? value.optional_weight : 0,
								}),
							},
						},
						schema: NewDocV2,
						previous: [{ version: 1, schema: V1OptionalString }],
					}),
				)
				expect(yield* lockProblems(rawV1Lock, handlesRawJson)).toEqual([])

				const CurrentTransformedV2 = Schema.Struct({
					count: Schema.FiniteFromString,
					output_tokens: NonNegativeInt,
				})
				const transformedBadMigrate: PersistedShape = {
					id,
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,

								migrate: (value) => ({
									count: typeof value.input_tokens === "number" ? String(value.input_tokens) : "0",
									output_tokens: value.output_tokens ?? 0,
								}),
							},
						},
						schema: CurrentTransformedV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					}),
				}
				expect(
					yield* decodeFailure(transformedBadMigrate, {
						version: 1,
						scope: "session",
						family: true,
						value: { input_tokens: 7, output_tokens: 5 },
					}),
				).not.toBeNull()
				expect(
					yield* decodeFailure(transformedBadMigrate, {
						version: 2,
						scope: "session",
						family: true,
						value: { count: "7", output_tokens: 5 },
					}),
				).not.toBeNull()

				const transformedRuntimeShape: PersistedShape = {
					id,
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									count: typeof value.input_tokens === "number" ? value.input_tokens : 0,
									output_tokens: value.output_tokens ?? 0,
								}),
							},
						},
						schema: CurrentTransformedV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					}),
				}
				expect(
					yield* decodeFailure(transformedRuntimeShape, {
						version: 2,
						scope: "session",
						family: true,
						value: { count: 7, output_tokens: 5 },
					}),
				).toBeNull()
				const generatedV2Samples = yield* sampleEncoded(transformedRuntimeShape, 4)
				expect(generatedV2Samples).toHaveLength(4)
				const v2RoundTripFailures: Array<string> = []
				for (const sample of generatedV2Samples) {
					const failure = yield* decodeFailure(transformedRuntimeShape, sample)
					if (failure !== null) {
						v2RoundTripFailures.push(failure)
					}
				}
				expect(v2RoundTripFailures).toEqual([])

				const WithDefaultedFieldV2 = Schema.Struct({
					prompt_tokens: NonNegativeInt,
					output_tokens: NonNegativeInt,
					cached_tokens: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
				})
				const omittedDefaultMigrate = piDocPersistedSchema({
					token: {
						definition: {
							...SettledUsage.definition,
							version: 2,
							migrate: (value) => ({
								prompt_tokens: value.input_tokens ?? 0,
								output_tokens: value.output_tokens ?? 0,
							}),
						},
					},
					schema: WithDefaultedFieldV2,
					previous: [{ version: 1, schema: SettledUsageState }],
				})
				expect(
					yield* decodeFailure(
						{ id, kind: "pi-doc", schema: omittedDefaultMigrate },
						{
							version: 1,
							scope: "session",
							family: true,
							value: { input_tokens: 10, output_tokens: 5 },
						},
					),
				).not.toBeNull()
				expect(yield* shipBlockers(lock, replacing(id, omittedDefaultMigrate))).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])

				const unversionedDefaultAdded = piDocPersistedSchema({
					token: SettledUsage,
					schema: Schema.Struct({
						input_tokens: NonNegativeInt,
						output_tokens: NonNegativeInt,
						cached_tokens: NonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
					}),
				})
				expect(yield* shipBlockers(lock, replacing(id, unversionedDefaultAdded))).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])

				const populatedDefaultMigrate = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									output_tokens: value.output_tokens ?? 0,
									cached_tokens: 0,
								}),
							},
						},
						schema: WithDefaultedFieldV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					}),
				)
				expect(
					yield* lockProblems(
						yield* reviewing(lock, id, populatedDefaultMigrate),
						populatedDefaultMigrate,
					),
				).toEqual([])

				const NumberFieldV2 = Schema.Struct({
					n: Schema.Number,
				})
				for (const coercedString of ["NaN", "Infinity", "-Infinity"] as const) {
					const coercedMigrateSchema = piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: () => ({ n: coercedString }),
							},
						},
						schema: NumberFieldV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					})
					const coercedShape: PersistedShape = { id, kind: "pi-doc", schema: coercedMigrateSchema }
					expect(
						yield* decodeFailure(coercedShape, {
							version: 1,
							scope: "session",
							family: true,
							value: { input_tokens: 10, output_tokens: 5 },
						}),
						`expected migrated { n: ${JSON.stringify(coercedString)} } to fail runtime validation`,
					).not.toBeNull()
					expect(
						yield* decodeFailure(coercedShape, {
							version: 2,
							scope: "session",
							family: true,
							value: { n: coercedString },
						}),
						`expected stored v2 { n: ${JSON.stringify(coercedString)} } to fail runtime validation`,
					).not.toBeNull()
					expect(yield* shipBlockers(lock, replacing(id, coercedMigrateSchema))).toEqual([
						expect.stringContaining(`${id} can no longer read a value written by baseline`),
					])
				}
				const unversionedNumberShape: PersistedShape = {
					id,
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: SettledUsage,
						schema: NumberFieldV2,
					}),
				}
				expect(
					yield* decodeFailure(unversionedNumberShape, {
						version: 1,
						scope: "session",
						family: true,
						value: { n: "NaN" },
					}),
				).not.toBeNull()
				expect(
					yield* decodeFailure(unversionedNumberShape, {
						version: 1,
						scope: "session",
						family: true,
						value: { n: 42 },
					}),
				).toBeNull()

				const V1PartialSchema = Schema.Struct({
					input_tokens: NonNegativeInt,
				})
				const V2RequiresNoExtraLeak = Schema.Struct({
					prompt_tokens: NonNegativeInt,
					extra_seen: Schema.Literal("stored"),
				})
				const extraKeyLock = lockWith({
					[id]: [
						{
							version: 1,
							scope: "session",
							family: true,
							value: { input_tokens: 10, legacy_extra: "stored" },
						},
					],
				})
				const breaksOnExtraKey = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,

								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									extra_seen: "legacy_extra" in value ? "unexpected_extra" : "stored",
								}),
							},
						},
						schema: V2RequiresNoExtraLeak,
						previous: [{ version: 1, schema: V1PartialSchema }],
					}),
				)
				expect(yield* shipBlockers(extraKeyLock, breaksOnExtraKey)).toEqual([
					expect.stringContaining(`${id} can no longer read a value written by baseline`),
				])
				const readsExtraKey = replacing(
					id,
					piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) => ({
									prompt_tokens: value.input_tokens ?? 0,
									extra_seen: value.legacy_extra ?? null,
								}),
							},
						},
						schema: V2RequiresNoExtraLeak,
						previous: [{ version: 1, schema: V1PartialSchema }],
					}),
				)
				expect(yield* lockProblems(extraKeyLock, readsExtraKey)).toEqual([])

				const nonStrictCases: ReadonlyArray<readonly [string, unknown]> = [
					["NaN", Number.NaN],
					["Infinity", Number.POSITIVE_INFINITY],
					["undefined", undefined],
					["Map", new Map([["a", 1]])],
				]
				for (const [label, badExtra] of nonStrictCases) {
					const badSchema = piDocPersistedSchema({
						token: {
							definition: {
								...SettledUsage.definition,
								version: 2,
								migrate: (value) =>
									({
										prompt_tokens: value.input_tokens ?? 0,
										output_tokens: value.output_tokens ?? 0,
										undeclared_bad: badExtra,
									}) as unknown as JsonObject,
							},
						},
						schema: SettledUsageV2,
						previous: [{ version: 1, schema: SettledUsageState }],
					})
					const badShape: PersistedShape = { id, kind: "pi-doc", schema: badSchema }
					const failure = yield* decodeFailure(badShape, {
						version: 1,
						scope: "session",
						family: true,
						value: { input_tokens: 10, output_tokens: 5 },
					})
					expect(
						failure,
						`expected ${label} migration output to fail strict JSON check`,
					).not.toBeNull()
					expect(yield* shipBlockers(lock, replacing(id, badSchema))).toEqual([
						expect.stringContaining(`${id} can no longer read a value written by baseline`),
					])
				}

				const convKind = "checkfu.conversation-note"
				const convId = piDocShapeId(convKind)
				const ConvV1 = Schema.Struct({ note: Schema.String })
				const ConvV2 = Schema.Struct({ summary: Schema.String })
				const makeConvShape = (
					history: "latest" | "rewindable",
					fork: "asOf" | "current" | "initial",
					version = 1,
				): PersistedShape => ({
					id: convId,
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: {
							definition: {
								kind: convKind,
								version,
								scope: "conversation",
								history,
								fork,
								...(version === 2
									? {
											migrate: (value) => ({
												summary: typeof value.note === "string" ? value.note : "",
											}),
										}
									: {}),
							},
						},
						schema: version === 2 ? ConvV2 : ConvV1,
						...(version === 2 ? { previous: [{ version: 1, schema: ConvV1 }] } : {}),
					}),
				})
				const convBase = makeConvShape("latest", "current")
				const convBaseline = yield* cutBaseline("conv-shipped", "2026-01-01T00:00:00.000Z", [
					convBase,
				])
				const convLock: PersistedLock = {
					version: 1,
					retired: {},
					reviewed: {},
					baselines: [convBaseline],
				}
				const changedHistory = makeConvShape("rewindable", "current")
				const changedFork = makeConvShape("latest", "initial")
				expect(yield* schemaFingerprint(changedHistory)).not.toBe(
					yield* schemaFingerprint(convBase),
				)
				expect(yield* schemaFingerprint(changedFork)).not.toBe(yield* schemaFingerprint(convBase))
				expect(yield* shipBlockers(convLock, [changedHistory])).toEqual([
					expect.stringContaining(`${convId} can no longer read a value written by baseline`),
				])
				expect(yield* shipBlockers(convLock, [changedFork])).toEqual([
					expect.stringContaining(`${convId} can no longer read a value written by baseline`),
				])

				expect(yield* shipBlockers(convLock, [makeConvShape("rewindable", "current", 2)])).toEqual([
					expect.stringContaining(`${convId} can no longer read a value written by baseline`),
				])

				const validConvV2 = [makeConvShape("latest", "current", 2)]
				expect(
					yield* lockProblems(yield* reviewing(convLock, convId, validConvV2), validConvV2),
				).toEqual([])
			}),
	)
})
