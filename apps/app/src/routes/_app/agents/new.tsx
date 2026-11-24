import { createFileRoute } from "@tanstack/react-router"
import { NewAgentPage } from "../../../pages/agents.tsx"

export const Route = createFileRoute("/_app/agents/new")({ component: NewAgentPage })
