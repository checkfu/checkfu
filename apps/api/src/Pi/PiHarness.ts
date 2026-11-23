import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import type { PiTurnOutcome, PiTurnRequest, PiTurnResult } from "./PiTurn.ts"

// Longer than DEFAULT_TURN_TIMEOUT_MS plus the settle margin, so a deploy resets neither the
// RunTurn saga in the API Worker nor the session object in the harness Worker mid-turn.
export const TURN_CODE_UPDATE_STRATEGY = {
	mode: "deferred",
	maxDelay: "12 minutes",
} as const

export type PiHarnessShape = {
	readonly recoverTurn: (
		conversation: string,
		operationId: string,
	) => Effect.Effect<PiTurnOutcome | null>
	readonly runTurn: (conversation: string, request: PiTurnRequest) => Effect.Effect<PiTurnResult>
	readonly abortTurn: (conversation: string, operationId: string) => Effect.Effect<boolean>
}

export class PiHarnessWorker extends Cloudflare.Worker<PiHarnessWorker, PiHarnessShape>()(
	"PiHarnessWorker",
) {}
