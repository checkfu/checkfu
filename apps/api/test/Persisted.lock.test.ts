import { AbandonTurn } from "@checkfu/domain/Session/AbandonTurn.command"
import { RUN_TURN_ACTIVITIES, RunTurn } from "@checkfu/domain/Session/RunTurn.saga"
import { UserMessage } from "@checkfu/domain/Session/SendUserMessage.command"
import { TurnInput, TurnInputState } from "@checkfu/domain/Session/TurnInput.view"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { DocumentId } from "@earendil-works/pi-durable"
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
import { CHECKFU_PI_DOCS, SettledUsage } from "../src/Pi/PiTurnUsage.ts"
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
			const callbacks = persistedShapes.filter(({ kind }) => kind === "webhook-callback")
			expect(callbacks.map(({ id }) => id)).toEqual([pageId, retryId])
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
						shapes: { [pageId]: [page], [retryId]: [retry] },
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
						"credentialAccess",
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
		"round-trips the current Pi document envelopes and rejects invalid metadata and values",
		() =>
			Effect.gen(function* () {
				for (const spec of CHECKFU_PI_DOCS) {
					const def = spec.token.definition
					const shape: PersistedShape = {
						id: piDocShapeId(def.kind),
						kind: "pi-doc",
						schema: piDocPersistedSchema(spec),
					}
					for (const stored of yield* sampleEncoded(shape, 3)) {
						const value = yield* Schema.decodeUnknownEffect(shape.schema)(stored)
						const envelope = yield* Schema.encodeUnknownEffect(shape.schema)(value)
						expect(envelope).toEqual(stored)
						expect(envelope).toMatchObject({
							version: def.version,
							scope: def.scope,
							family: def.family === true,
						})
						if (typeof stored !== "object" || stored === null) {
							throw new Error("Expected a Pi document envelope")
						}
						for (const change of [
							{ scope: "task" },
							{ family: def.family !== true },
							{ version: def.version + 1 },
							{ value: {} },
							{ value: [] },
						]) {
							expect(yield* decodeFailure(shape, { ...stored, ...change })).not.toBeNull()
						}
					}
				}
				const transformed: PersistedShape = {
					id: piDocShapeId(SettledUsage.definition.kind),
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: SettledUsage,
						schema: Schema.Struct({
							count: Schema.FiniteFromString,
							weight: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(42))),
						}),
					}),
				}
				const envelope = { version: 1, scope: "session", family: true }
				expect(
					yield* decodeFailure(transformed, { ...envelope, value: { count: 1, weight: 42 } }),
				).toBeNull()
				for (const value of [
					{ count: "1", weight: 42 },
					{ count: 1 },
					{ count: 1, weight: Number.NaN },
				]) {
					expect(yield* decodeFailure(transformed, { ...envelope, value })).not.toBeNull()
				}
			}),
	)

	it.effect(
		"checks conversation history and fork semantics in the current Pi document envelope",
		() =>
			Effect.gen(function* () {
				const definition = { kind: "checkfu.test-note", version: 1, scope: "conversation" as const }
				const schema = Schema.Struct({ note: Schema.String })
				expect(() => piDocPersistedSchema({ token: { definition }, schema })).toThrow(
					"history and fork",
				)
				const shape: PersistedShape = {
					id: piDocShapeId(definition.kind),
					kind: "pi-doc",
					schema: piDocPersistedSchema({
						token: { definition: { ...definition, history: "latest", fork: "current" } },
						schema,
					}),
				}
				const stored = {
					version: 1,
					scope: "conversation",
					history: "latest",
					fork: "current",
					family: false,
					value: { note: "test" },
				}
				expect(yield* decodeFailure(shape, stored)).toBeNull()
				expect(yield* decodeFailure(shape, { ...stored, history: "rewindable" })).not.toBeNull()
				expect(yield* decodeFailure(shape, { ...stored, fork: "initial" })).not.toBeNull()
			}),
	)
})
