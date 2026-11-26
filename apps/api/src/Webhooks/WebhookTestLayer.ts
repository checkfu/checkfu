import { ListingStore } from "@checkfu/domain/Listing/ListingStore"
import { Webhooks, WebhooksHandlersLive } from "@checkfu/domain/Webhooks.model"
import * as Mac from "effect/crypto/Mac"
import * as Layer from "effect/Layer"
import { makeWebhookDeliveryStoreMemory } from "./WebhookDeliveryStoreMemory.ts"
import type { MemoryWebhookDeliveryOptions } from "./WebhookDeliveryStoreMemory.ts"
import { WebhookSigningMasterKeyTest } from "./WebhookSigning.ts"

export const makeWebhooksTestSupport = (
	listingLayer: Layer.Layer<ListingStore> = ListingStore.memory,
	options: MemoryWebhookDeliveryOptions = {},
) => {
	const webhooksLayer = Webhooks.layer(WebhooksHandlersLive.pipe(Layer.provide(listingLayer)))
	const deliveries = makeWebhookDeliveryStoreMemory(options)
	const deliveriesLayer = deliveries.layer.pipe(
		Layer.provide(webhooksLayer),
		Layer.provide(WebhookSigningMasterKeyTest),
		Layer.provide(Mac.layerWebCrypto),
	)
	const layer = Layer.mergeAll(
		webhooksLayer,
		deliveriesLayer,
		WebhookSigningMasterKeyTest,
		Mac.layerWebCrypto,
	)
	return { layer, webhooksLayer, deliveriesLayer, deliveries }
}
