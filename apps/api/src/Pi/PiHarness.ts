import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import type { SessionMemory } from "../Workspace/SessionMemory.ts"
import type { PiHarnessCalls } from "./PiTurn.ts"

// Longer than DEFAULT_TURN_TIMEOUT_MS plus the settle margin, so a deploy resets neither the
// RunTurn saga in the API Worker nor the session object in the harness Worker mid-turn.
export const TURN_CODE_UPDATE_STRATEGY = {
	mode: "deferred",
	maxDelay: "12 minutes",
} as const

type Calls = typeof PiHarnessCalls

type LockedShape = {
	readonly [Method in keyof Calls]: (
		...args: Calls[Method]["args"]["Type"]
	) => Effect.Effect<Calls[Method]["result"]["Type"]>
}

// A turn also carries the session's memory stores, by reference for the length of the call: a
// callback, not data, so it is not one of the shapes the lock holds.
export type PiHarnessShape = Omit<LockedShape, "runTurn"> & {
	readonly runTurn: (
		...args: [...Calls["runTurn"]["args"]["Type"], memory: SessionMemory]
	) => Effect.Effect<Calls["runTurn"]["result"]["Type"]>
}

export class PiHarnessWorker extends Cloudflare.Worker<PiHarnessWorker, PiHarnessShape>()(
	"PiHarnessWorker",
) {}
