import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { placement } from "./Placement.ts"

export const DOMAIN_RETENTION = {
	receipts: "forever",
	deliveries: "forever",
	cancelled: "forever",
} as const

export const PlacedDurableObjects = Layer.unwrap(
	Effect.map(placement, (where) =>
		DomainCloudflare.layerDurableObjects({ ...where, retention: DOMAIN_RETENTION }),
	),
)
