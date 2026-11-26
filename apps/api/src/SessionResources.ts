import { Session } from "@checkfu/domain/Session/Session.aggregate"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import type { SessionResource } from "@checkfu/domain/Session/SessionResource"
import { SessionView } from "@checkfu/domain/Session/SessionView.view"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const SESSION_VIEW_WAIT = "10 seconds"

export const SessionResources = Effect.gen(function* () {
	const sessions = yield* SessionView
	return (sessionId: string): Effect.Effect<ReadonlyArray<SessionResource>> => {
		const id = SessionId.make(sessionId)
		const ref = Session.ref(id)
		return Effect.gen(function* () {
			const shown = Option.getOrNull(yield* sessions.get(ref))
			const session =
				shown ?? (yield* sessions.waitFor(ref, { id }, { timeout: SESSION_VIEW_WAIT }))
			return session?.resources ?? []
		}).pipe(Effect.orDie)
	}
})
