import { createFileRoute } from "@tanstack/react-router"
import { NewEnvironmentPage } from "../../../pages/environments.tsx"

export const Route = createFileRoute("/_app/environments/new")({ component: NewEnvironmentPage })
