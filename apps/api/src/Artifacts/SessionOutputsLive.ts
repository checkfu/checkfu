import { AddArtifactVersion } from "@checkfu/domain/Artifact/AddArtifactVersion.command"
import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { CreateArtifact } from "@checkfu/domain/Artifact/CreateArtifact.command"
import { ReserveArtifact } from "@checkfu/domain/Artifact/ReserveArtifact.command"
import { Session } from "@checkfu/domain/Session/Session.aggregate"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import { SessionOutputs } from "@checkfu/domain/Session/SessionOutputs.external"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { outputsArtifactId, outputsArtifactName } from "../OutputsIdentity.ts"
import { HarnessLimits, PiTurnExecutor } from "../Pi/PiDurableHarness.ts"
import type { OutputFile } from "../Workspace/SessionOutputs.ts"
import { sealArtifactFiles } from "./ArtifactFiles.ts"
import type { ArtifactBlob } from "./ArtifactFiles.ts"
import { ArtifactStore } from "./ArtifactStore.ts"

export const OutputsPublishTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/OutputsPublishTimeout",
	{ defaultValue: () => "30 seconds" },
)

const OUTPUTS_READ_BATCH_BYTES = 2_000_000

class OutputChanged extends Schema.TaggedError<OutputChanged, { readonly brand: unique symbol }>()(
	"OutputChanged",
	{ path: Schema.String },
) {}

class SessionNotProjected extends Schema.TaggedError<
	SessionNotProjected,
	{ readonly brand: unique symbol }
>()("SessionNotProjected", {}) {}

class OutputsSuperseded extends Schema.TaggedError<
	OutputsSuperseded,
	{ readonly brand: unique symbol }
>()("OutputsSuperseded", {}) {}

export const makeSessionOutputsPublisher = Effect.gen(function* () {
	const executor = yield* PiTurnExecutor
	const artifacts = yield* Artifact
	const artifactStore = yield* ArtifactStore
	const digest = yield* Digest.Digest
	const sessionViews = yield* SessionView

	const readMissing = (sessionId: string, turn: number, wanted: ReadonlyArray<OutputFile>) =>
		Effect.gen(function* () {
			const blobs: Array<ArtifactBlob> = []
			let batch: Array<OutputFile> = []
			let batchBytes = 0
			const flush = Effect.gen(function* () {
				const asked = batch
				batch = []
				batchBytes = 0
				if (asked.length === 0) {
					return
				}
				const read = yield* executor.readOutputs(
					sessionId,
					turn,
					asked.map((file) => file.path),
				)
				if (read === null) {
					return yield* new OutputsSuperseded()
				}
				const byPath = new Map(read.map((file) => [file.path, file.bytes]))
				for (const file of asked) {
					const bytes = byPath.get(file.path)
					if (
						bytes === undefined ||
						(yield* digest.digestHex(Digest.sha256, bytes)) !== file.sha256
					) {
						return yield* new OutputChanged({ path: file.path })
					}
					blobs.push({ sha256: file.sha256, bytes })
				}
			})
			for (const file of wanted) {
				batch.push(file)
				batchBytes += file.size
				if (batchBytes >= OUTPUTS_READ_BATCH_BYTES) {
					yield* flush
				}
			}
			yield* flush
			return blobs
		})

	const publishOnce = Effect.fn("SessionOutputs.publish")(function* (
		sessionId: SessionId,
		turn: number,
	) {
		const listing = yield* executor.listOutputs(sessionId, turn)
		if (listing === null) {
			return yield* new OutputsSuperseded()
		}
		if (!listing.ok) {
			return yield* Effect.logWarning("Outputs not published", listing.reason)
		}
		if (listing.files.length === 0) {
			return
		}
		const sealed = yield* Effect.result(sealArtifactFiles(digest, listing.files))
		if (Result.isFailure(sealed)) {
			return yield* Effect.logWarning("Outputs not published", sealed.failure.message)
		}
		const { manifest_hash } = sealed.success
		const artifactId = yield* outputsArtifactId(digest, sessionId)
		const current = yield* artifacts.get(artifactId)
		if (current.status === "deleted" || current.manifest === manifest_hash) {
			return
		}
		const held = new Set(
			current.status === "active"
				? ((yield* artifactStore.getManifest(artifactId, current.manifest))?.files.map(
						(file) => file.sha256,
					) ?? [])
				: [],
		)
		const missing = new Map<string, OutputFile>()
		for (const file of listing.files) {
			if (!held.has(file.sha256) && !missing.has(file.sha256)) {
				missing.set(file.sha256, file)
			}
		}
		const blobs = yield* readMissing(sessionId, turn, [...missing.values()])
		const built = { ...sealed.success, blobs }
		const version = {
			artifact_id: artifactId,
			manifest: manifest_hash,
			file_count: sealed.success.file_count,
			total_bytes: sealed.success.total_bytes,
		}
		const sendOptions = {
			commandId: `outputs:${sessionId}:${turn}:${current.version}:${manifest_hash}`,
		}
		if (current.status === "active") {
			yield* artifactStore.stage(artifactId, built, null)
			yield* artifacts.send(
				new AddArtifactVersion({ ...version, expected_version: current.version }),
				sendOptions,
			)
			return
		}
		const session = yield* sessionViews.waitFor(
			Session.ref(sessionId),
			{ id: sessionId },
			{ timeout: "5 seconds" },
		)
		if (session === null) {
			return yield* new SessionNotProjected()
		}
		const reservation = yield* artifacts
			.send(new ReserveArtifact({ artifact_id: artifactId }))
			.pipe(
				Effect.map((reserved) => reserved.reply.reservation),
				Effect.catchTag("ArtifactAlreadyExists", () => Effect.succeed(0)),
			)
		if (reservation === 0) {
			return
		}
		yield* artifactStore.stage(artifactId, built, reservation)
		yield* artifacts.send(
			new CreateArtifact({
				...version,
				reservation,
				name: outputsArtifactName(sessionId, session.title),
			}),
			sendOptions,
		)
	})

	return {
		publish: ({ session_id, turn }: { readonly session_id: SessionId; readonly turn: number }) =>
			Effect.gen(function* () {
				const { attempts, baseDelay } = yield* HarnessLimits
				yield* publishOnce(session_id, turn).pipe(
					Effect.retry({
						while: (error) => error._tag !== "OutputsSuperseded",
						times: attempts - 1,
						schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
					}),
					Effect.catchTag("OutputsSuperseded", () =>
						Effect.logInfo("Outputs not published: a later turn has started"),
					),
					Effect.timeoutOrElse({
						duration: yield* OutputsPublishTimeout,
						orElse: () => Effect.logWarning("Outputs not published in time"),
					}),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logError("Outputs not published", cause),
					),
					Effect.annotateLogs({ sessionId: session_id, turn }),
				)
			}),
	}
})

export const SessionOutputsLive = SessionOutputs.toLayer(makeSessionOutputsPublisher)
