import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ArtifactBytes } from "../src/Artifact/ArtifactBytes.external.ts"
import { Artifacts, ArtifactsApi, ArtifactsHandlersLive } from "../src/Artifacts.model.ts"

const story = Story.make(Artifacts, { layer: ArtifactsHandlersLive, stub: [ArtifactBytes] })

const STANDING = {
	"Artifact.StatusIsKnown": "proved",
	"Artifact.CreatedExactlyWhenVersioned": "proved",
	"Artifact.CreatedArtifactNeverReturnsToUninitialized": "proved",
	"Artifact.DeletedStaysDeleted": "proved",
	"Artifact.NameNeverChangesOnceCreated": "proved",
	"Artifact.VersionGrowsByOneOrNotAtAll": "proved",
	"Artifact.AddedVersionRecordsItsManifest": "proved",
	"Artifact.ADeletedArtifactIsNotPublished": "proved",
	"Artifact.PublishedOnlyOnceCreated": "proved",
	"Artifact.UnpublishedHoldsNoSettings": "proved",
	"Artifact.PinnedVersionWithinHead": "proved",
	"Artifact.AReservationIsOpenOnlyBeforeCreation": "proved",
	"Artifact.OnlyTheLatestReservationIsOpen": "proved",
	"Artifact.ATokenIsOnlyOpenedOrDropped": "proved",
	"Artifact.UnpublishDropsTheToken": "proved",
	"Artifact.PublishKeepsTheTokenOrTakesTheFreshOne": "proved",
	"Artifact.PublishServesAVersionTheArtifactHas": "proved",
	"Artifact.ReservationsAreNumberedInOrder": "proved",
	"Artifact.CreatingTakesTheOpenReservation": "proved",
	"Artifact.OpeningTakesTheOpenReservation": "proved",
	"Artifact.ClaimingAKeyChangesNoState": "proved",
	"Artifacts.EveryArtifactVersionIsWithinItsArtifactsHead": "checked",
	"Artifacts.EveryArtifactVersionIsRecorded": "checked",
	"Artifacts.NoReservationStaysOpen": "checked",
	"Artifacts.AnArtifactGainsASecondVersion": "reached",
	"Artifacts.AnArtifactIsDeleted": "reached",
	"Artifacts.AnArtifactIsPublished": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Artifacts Z3 formal verification", () => {
	it.live(
		"proves every Artifact invariant and transition in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Artifacts, {
					apis: [ArtifactsApi],
					story,
					instances: 1,
					walks: { count: 50 },
					lock: "./Artifacts.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				yield* Effect.logInfo(Verify.render(report))
				expect(report.explored.followed.toSorted()).toEqual([
					"ExpireArtifactReservations",
					"ReleaseArtifactBytes",
				])
				expect(report.explored.idle).toEqual([])
				expect(report.explored.sagas).toEqual([])
				expect(report.explored.unstarted).toEqual([])
				expect(report.explored.skipped.map((skipped) => skipped.policy)).toEqual([])
				expect(report.explored.aside).toEqual([])
				expect(report.explored.disagreements).toEqual([])
				expect(report.explored.agreement.compared).toBeGreaterThan(0)
			}).pipe(Effect.provide(NodeServices.layer)),
		120_000,
	)
})
