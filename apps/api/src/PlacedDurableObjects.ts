import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placement } from "./Placement.ts"

export const PlacedDurableObjects = Layer.unwrap(
	Effect.map(placement, DomainCloudflare.layerDurableObjects),
)
