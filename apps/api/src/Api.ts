import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Effect from "effect/Effect"
import { SessionMemoryCalls } from "./Workspace/SessionMemory.ts"

/** Every call into the API Worker from another Worker, with the shapes they carry. */
export const ApiCalls = { ...SessionMemoryCalls }

type Calls = typeof ApiCalls

export type ApiShape = {
	readonly [Method in keyof Calls]: (
		...args: Calls[Method]["args"]["Type"]
	) => Effect.Effect<Calls[Method]["result"]["Type"]>
}

export class ApiWorker extends Cloudflare.Worker<ApiWorker, ApiShape>()("ApiWorker") {}
