import { createFileRoute } from "@tanstack/react-router"
import { WebhooksPage } from "../../../pages/webhooks.tsx"

export const Route = createFileRoute("/_app/webhooks/")({ component: WebhooksPage })
