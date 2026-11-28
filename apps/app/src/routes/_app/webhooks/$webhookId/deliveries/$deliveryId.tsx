import { createFileRoute } from "@tanstack/react-router"
import { WebhookDeliveryPage } from "../../../../../pages/webhooks.tsx"

export const Route = createFileRoute("/_app/webhooks/$webhookId/deliveries/$deliveryId")({
	component: WebhookDeliveryPage,
})
