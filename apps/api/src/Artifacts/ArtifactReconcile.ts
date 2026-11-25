import { Artifact } from "@checkfu/domain/Artifact/Artifact.aggregate"
import type { ArtifactState } from "@checkfu/domain/Artifact/Artifact.aggregate"
import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "@checkfu/domain/Artifact/ArtifactVersionView.view"
import { FenceArtifactWrites } from "@checkfu/domain/Artifact/FenceArtifactWrites.command"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ARTIFACT_WRITE_GRACE_MS } from "./ArtifactOwnership.ts"
import { ArtifactStore, isDeleteMarker } from "./ArtifactStore.ts"
import type { ArtifactWriteCheck, UnconfirmedWrite } from "./ArtifactStore.ts"

export const ARTIFACT_RECONCILE_CRON = "*/15 * * * *"
export const ARTIFACT_RECONCILE_BATCH = 200
export const ARTIFACT_RECONCILE_PAGE = 1000

export type WriteSettlement = "confirm" | "abandon" | "wait"

type SeenState = Pick<ArtifactState, "status" | "version" | "manifest">
type SeenRow = { readonly manifest: string } | null

export const targetVersion = (check: ArtifactWriteCheck) =>
	check.kind === "create" ? 1 : check.expected_version + 1

export const settleWrite = (
	check: ArtifactWriteCheck,
	state: SeenState,
	row: SeenRow,
): WriteSettlement => {
	const target = targetVersion(check)
	if (state.status !== "active" || state.version < target) {
		return "abandon"
	}
	const manifest = state.version === target ? state.manifest : row?.manifest
	if (manifest === undefined) {
		return "wait"
	}
	return manifest === check.manifest ? "confirm" : "abandon"
}

export const settleBeforeFence = (
	check: ArtifactWriteCheck,
	state: SeenState,
	row: SeenRow,
): WriteSettlement | "fence" => {
	const settlement = settleWrite(check, state, row)
	const couldStillLand =
		check.kind === "create"
			? state.status === ""
			: state.status === "active" && state.version < targetVersion(check)
	return settlement === "abandon" && couldStillLand ? "fence" : settlement
}

export const fenceCommandId = (artifactId: string, writeId: string) =>
	`fence:${artifactId}:${writeId}`

export const reconcileArtifactWrites = Effect.gen(function* () {
	const store = yield* ArtifactStore
	const artifacts = yield* Artifact
	const versionViews = yield* ArtifactVersionView

	const look = (id: ArtifactId, check: ArtifactWriteCheck) =>
		Effect.gen(function* () {
			const state = yield* artifacts.get(id)
			const target = targetVersion(check)
			const row =
				state.status === "active" && state.version > target
					? Option.getOrNull(yield* versionViews.get(artifactVersionLookupKey(id, target)))
					: null
			return { state, row }
		})

	const finishDelete = (write: UnconfirmedWrite) =>
		Effect.gen(function* () {
			const id = ArtifactId.make(write.artifact_id)
			let status = (yield* artifacts.get(id)).status
			if (status === "active") {
				yield* artifacts.send(new FenceArtifactWrites({ artifact_id: id }), {
					commandId: fenceCommandId(write.artifact_id, write.write_id),
				})
				status = (yield* artifacts.get(id)).status
				if (status === "active") {
					yield* write.confirm
				}
			}
			if (status === "deleted") {
				yield* store.purge(id)
			}
			return undefined
		})

	const reconcile = (write: UnconfirmedWrite) =>
		Effect.gen(function* () {
			if (isDeleteMarker(write.write_id)) {
				return yield* finishDelete(write)
			}
			const marker = yield* write.marker
			if (marker === null) {
				return undefined
			}
			const id = ArtifactId.make(marker.artifact_id)
			const first = yield* look(id, marker.check)
			const before = settleBeforeFence(marker.check, first.state, first.row)
			let settlement: WriteSettlement
			if (before === "fence") {
				yield* artifacts.send(new FenceArtifactWrites({ artifact_id: id }), {
					commandId: fenceCommandId(write.artifact_id, write.write_id),
				})
				const fenced = yield* look(id, marker.check)
				settlement = settleWrite(marker.check, fenced.state, fenced.row)
			} else {
				settlement = before
			}
			if (settlement === "confirm") {
				yield* write.confirm
			} else if (settlement === "abandon") {
				yield* write.abandon
			}
			return settlement
		}).pipe(
			Effect.catchCause((cause) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.as(
							Effect.logError("Artifact write reconciliation failed", {
								artifact_id: write.artifact_id,
								write_id: write.write_id,
								cause,
							}),
							undefined,
						),
			),
		)

	const cursor = yield* store.reconcileCursor
	const page = yield* store.unconfirmedWrites(cursor, ARTIFACT_RECONCILE_PAGE)
	let examined = cursor
	let next = page.next
	let handled = 0
	for (const write of page.writes) {
		if (write.age >= ARTIFACT_WRITE_GRACE_MS) {
			if (handled === ARTIFACT_RECONCILE_BATCH) {
				next = examined
				break
			}
			handled += 1
			yield* reconcile(write)
		}
		examined = write.key
	}
	yield* store.saveReconcileCursor(next)
}).pipe(
	Effect.catchCause((cause) =>
		Cause.hasInterruptsOnly(cause)
			? Effect.interrupt
			: Effect.logError("Artifact write reconciliation failed", cause),
	),
)
