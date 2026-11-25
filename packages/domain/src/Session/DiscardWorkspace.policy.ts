import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { SessionStatusTerminated } from "./ArchiveSession.command.ts"
import { Harness } from "./Harness.external.ts"
import { Session } from "./Session.aggregate.ts"

export class DiscardWorkspace extends Domain.Policy("DiscardWorkspace", {
	from: Session,
	on: [SessionStatusTerminated],
}) {}

export const DiscardWorkspaceLive = DiscardWorkspace.toLayer(
	Effect.gen(function* () {
		const harness = yield* Harness
		return ({ source }) => harness.discardWorkspace({ session_id: source.id })
	}),
)
