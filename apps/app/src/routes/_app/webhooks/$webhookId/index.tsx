import { createFileRoute } from "@tanstack/react-router"
import { WebhookPage } from "../../../../pages/webhooks.tsx"

export const Route = createFileRoute("/_app/webhooks/$webhookId/")({ component: WebhookPage })
