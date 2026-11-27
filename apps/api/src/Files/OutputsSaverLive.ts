import { File } from "@checkfu/domain/File/File.aggregate"
import { FileId } from "@checkfu/domain/File/File.id"
import {
	MAX_OUTPUT_FILES,
	MAX_OUTPUT_REASON_LENGTH,
	encodeSavedOutputs,
	encodeSkippedOutputs,
} from "@checkfu/domain/Outputs/OutputsTypes"
import type { SavedOutput, SkippedOutput } from "@checkfu/domain/Outputs/OutputsTypes"
import { RecordSessionOutputs } from "@checkfu/domain/Outputs/RecordSessionOutputs.command"
import { SessionOutputs } from "@checkfu/domain/Outputs/SessionOutputs.aggregate"
import { SkipSessionOutputs } from "@checkfu/domain/Outputs/SkipSessionOutputs.command"
import { OutputsSaver } from "@checkfu/domain/Session/OutputsSaver.external"
import type { SessionId } from "@checkfu/domain/Session/Session.id"
import { FileName } from "@checkfu/sdk/Schemas"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Digest from "effect/crypto/Digest"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Mime from "effect/http/Mime"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { HarnessLimits, PiTurnExecutor } from "../Pi/PiDurableHarness.ts"
import type { OutputFile } from "../Workspace/SessionOutputs.ts"
import { makeStoreFile } from "./StoreFile.ts"

export const OutputsSaveTimeout = Context.Reference<Duration.Input>(
	"@checkfu/api/OutputsSaveTimeout",
	{ defaultValue: () => "30 seconds" },
)

const OUTPUTS_READ_BATCH_BYTES = 2_000_000
const DEFAULT_CONTENT_TYPE = "application/octet-stream"

const SUPERSEDED = "A later turn started before the outputs were read."
const TIMED_OUT = "Saving the outputs took too long."
const FAILED = "The outputs could not be saved."
const CHANGED = "Changed while it was being read."

class OutputsSuperseded extends Schema.TaggedError<
	OutputsSuperseded,
	{ readonly brand: unique symbol }
>()("OutputsSuperseded", {}) {}

class OutputsNotSaved extends Schema.TaggedError<
	OutputsNotSaved,
	{ readonly brand: unique symbol }
>()("OutputsNotSaved", { cause: Schema.Unknown }) {}

const utf8Encoder = new TextEncoder()
const isFileName = Schema.is(FileName)

export const outputFileId = (
	digest: Digest.Digest["Service"],
	sessionId: string,
	path: string,
	sha256: string,
): Effect.Effect<FileId> =>
	Effect.map(
		digest.digestHex(
			Digest.sha256,
			utf8Encoder.encode(JSON.stringify(["session", "output", sessionId, path, sha256])),
		),
		(hash) => FileId.make(`file_${hash.slice(0, 32)}`),
	)

const byPath = (left: { readonly path: string }, right: { readonly path: string }) =>
	left.path < right.path ? -1 : left.path > right.path ? 1 : 0

export const makeOutputsSaver = Effect.gen(function* () {
	const executor = yield* PiTurnExecutor
	const files = yield* File
	const outputs = yield* SessionOutputs
	const digest = yield* Digest.Digest
	const storeFile = yield* makeStoreFile

	const readBytes = (sessionId: string, turn: number, wanted: ReadonlyArray<OutputFile>) =>
		Effect.gen(function* () {
			const read = new Map<string, Uint8Array>()
			let batch: Array<OutputFile> = []
			let batchBytes = 0
			const flush = Effect.gen(function* () {
				const asked = batch
				batch = []
				batchBytes = 0
				if (asked.length === 0) {
					return
				}
				const answered = yield* executor.readOutputs(
					sessionId,
					turn,
					asked.map(({ path, size }) => ({ path, size })),
				)
				if (answered === null) {
					return yield* new OutputsSuperseded()
				}
				for (const { path, bytes } of answered) {
					read.set(path, bytes)
				}
			})
			for (const file of wanted) {
				if (batchBytes + file.size > OUTPUTS_READ_BATCH_BYTES) {
					yield* flush
				}
				batch.push(file)
				batchBytes += file.size
			}
			yield* flush
			return read
		})

	const saveOnce = Effect.fn("SessionOutputs.save")(function* (sessionId: SessionId, turn: number) {
		if ((yield* outputs.get(sessionId)).turn >= turn) {
			return
		}
		const listing = yield* executor.listOutputs(sessionId, turn)
		if (listing === null) {
			return yield* new OutputsSuperseded()
		}
		if (!listing.ok) {
			yield* outputs.send(
				new SkipSessionOutputs({
					session_id: sessionId,
					turn,
					reason: listing.reason.slice(0, MAX_OUTPUT_REASON_LENGTH),
				}),
			)
			return
		}
		const saved: Array<SavedOutput> = []
		const skipped: Array<SkippedOutput> = [...listing.skipped]
		const wanted: Array<OutputFile & { readonly id: FileId }> = []
		for (const file of listing.files) {
			const filename = file.path.slice(file.path.lastIndexOf("/") + 1)
			if (!isFileName(filename)) {
				skipped.push({ path: file.path, reason: "Its name is too long for a file." })
				continue
			}
			const id = yield* outputFileId(digest, sessionId, file.path, file.sha256)
			const held = yield* files.get(id)
			if (held.status === "ready") {
				saved.push({
					path: file.path,
					file_id: id,
					size: held.size,
					sha256: held.sha256,
					content_type: held.content_type,
				})
			} else if (held.status === "deleted") {
				skipped.push({ path: file.path, reason: "Its saved file was deleted." })
			} else {
				wanted.push({ ...file, id })
			}
		}
		const skip = (reason: string) =>
			outputs.send(new SkipSessionOutputs({ session_id: sessionId, turn, reason }))
		const tooManySkipped = Effect.suspend(() =>
			skip(`${skipped.length} outputs could not be saved.`),
		)
		if (skipped.length > MAX_OUTPUT_FILES) {
			return yield* tooManySkipped
		}
		const read = yield* readBytes(sessionId, turn, wanted)
		for (const file of wanted) {
			const bytes = read.get(file.path)
			if (
				bytes === undefined ||
				bytes.byteLength !== file.size ||
				(yield* digest.digestHex(Digest.sha256, bytes)) !== file.sha256
			) {
				skipped.push({ path: file.path, reason: CHANGED })
				continue
			}
			const content_type = Option.getOrElse(
				Mime.getType(`./${file.path}`),
				() => DEFAULT_CONTENT_TYPE,
			)
			const outcome = yield* storeFile({
				id: file.id,
				filename: file.path.slice(file.path.lastIndexOf("/") + 1),
				content_type,
				origin: { session_id: sessionId, turn, path: file.path },
				body: Stream.make(bytes),
				size: file.size,
			})
			if (outcome._tag !== "Stored") {
				return yield* new OutputsNotSaved({ cause: `${file.path}: ${outcome._tag}` })
			}
			saved.push({
				path: file.path,
				file_id: file.id,
				size: file.size,
				sha256: file.sha256,
				content_type,
			})
		}
		if (skipped.length > MAX_OUTPUT_FILES) {
			return yield* tooManySkipped
		}
		const filesText = encodeSavedOutputs(saved.toSorted(byPath))
		const skippedText = encodeSkippedOutputs(skipped.toSorted(byPath))
		if (filesText === undefined || skippedText === undefined) {
			return yield* skip("The outputs are too many to record.")
		}
		yield* outputs.send(
			new RecordSessionOutputs({
				session_id: sessionId,
				turn,
				files: filesText,
				skipped: skippedText,
			}),
		)
	})

	return {
		save: ({ session_id, turn }: { readonly session_id: SessionId; readonly turn: number }) =>
			Effect.gen(function* () {
				const { attempts, baseDelay } = yield* HarnessLimits
				const skip = (reason: string) =>
					outputs.send(new SkipSessionOutputs({ session_id, turn, reason }))
				yield* saveOnce(session_id, turn).pipe(
					Effect.retry({
						while: (error) => error._tag !== "OutputsSuperseded",
						times: attempts - 1,
						schedule: Schedule.exponential(baseDelay).pipe(Schedule.jittered),
					}),
					Effect.catchTag("OutputsSuperseded", () => skip(SUPERSEDED)),
					Effect.timeoutOrElse({
						duration: yield* OutputsSaveTimeout,
						orElse: () => skip(TIMED_OUT),
					}),
					Effect.catchCause((cause) =>
						Cause.hasInterrupts(cause)
							? Effect.interrupt
							: Effect.andThen(Effect.logError("Outputs not saved", cause), skip(FAILED)),
					),
					Effect.annotateLogs({ sessionId: session_id, turn }),
				)
			}),
	}
})

export const OutputsSaverLive = OutputsSaver.toLayer(makeOutputsSaver)
