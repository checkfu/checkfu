import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Stream from "effect/Stream"
import type { PreviewPacket } from "./PiEventPreviews.ts"
import type * as Effect from "effect/Effect"
import type { PiHarnessCalls } from "./PiTurn.ts"

export const TURN_CODE_UPDATE_STRATEGY = {
	mode: "deferred",
	maxDelay: "12 minutes",
} as const

type Calls = typeof PiHarnessCalls

export type PiHarnessShape = {
	readonly [Method in keyof Calls]: (
		...args: Calls[Method]["args"]["Type"]
	) => Effect.Effect<Calls[Method]["result"]["Type"]>
} & { readonly watchPreviews: (conversation: string) => Stream.Stream<PreviewPacket> }

export class PiHarnessWorker extends Cloudflare.Worker<PiHarnessWorker, PiHarnessShape>()(
	"PiHarnessWorker",
) {}
