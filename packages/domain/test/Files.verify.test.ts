import { Story } from "@alchemy.run/domain/Story"
import * as Verify from "@alchemy.run/domain/Verify"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { FileBytes } from "../src/File/FileBytes.external.ts"
import { Files, FilesApi, FilesHandlersLive } from "../src/Files.model.ts"

const story = Story.make(Files, { layer: FilesHandlersLive, stub: [FileBytes] })

const STANDING = {
	"File.StatusIsKnown": "proved",
	"File.DescribedExactlyWhenCreated": "proved",
	"File.AnOriginNamesASessionATurnAndAPathOrNone": "proved",
	"File.AReservationIsOpenOnlyBeforeCreation": "proved",
	"File.OnlyTheLatestReservationIsOpen": "proved",
	"File.CreatedFileNeverReturnsToUninitialized": "proved",
	"File.DeletedStaysDeleted": "proved",
	"File.ContentNeverChanges": "proved",
	"File.ReservationsAreNumberedInOrder": "proved",
	"File.CreatingTakesTheOpenReservation": "proved",
	"SessionOutputs.OutcomeIsKnown": "proved",
	"SessionOutputs.AnOutcomeIsRecordedExactlyWhenATurnIs": "proved",
	"SessionOutputs.AReasonIsGivenExactlyWhenTheTurnWasSkipped": "proved",
	"SessionOutputs.TheRecordedTurnNeverGoesBack": "proved",
	"SessionOutputs.ATurnIsRecordedAtMostOnce": "proved",
	"SessionOutputs.ASkippedTurnKeepsTheFilesSavedBefore": "proved",
	"SessionOutputs.ASavedTurnReplacesTheFiles": "proved",
	"SessionOutputs.NothingChangesWithoutARecord": "proved",
	"Files.NoFileReservationStaysOpen": "checked",
	"Files.AFileIsCreated": "reached",
	"Files.AFileIsDeleted": "reached",
	"Files.ASessionProducesAFile": "reached",
	"Files.OutputsAreSaved": "reached",
	"Files.OutputsAreSkippedAfterASave": "reached",
} as const

const PROVED = Object.entries(STANDING)
	.filter(([, standing]) => standing === "proved")
	.map(([name]) => name)

describe("Files Z3 formal verification", () => {
	it.live(
		"proves every File invariant and transition in Z3",
		() =>
			Effect.gen(function* () {
				const report = yield* Verify.model(Files, {
					apis: [FilesApi],
					story,
					instances: 1,
					walks: { count: 50 },
					lock: "./Files.verify.lock.json",
					require: { proved: PROVED },
				})
				expect(Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]))).toEqual(
					STANDING,
				)
				expect(report.undone).toEqual([])
				yield* Effect.logInfo(Verify.render(report))
				expect(report.explored.followed.toSorted()).toEqual([
					"ExpireFileReservations",
					"ReleaseFileBytes",
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
