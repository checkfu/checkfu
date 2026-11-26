import { createFileRoute } from "@tanstack/react-router"
import { NewMemoryStorePage } from "../../../pages/memory.tsx"

export const Route = createFileRoute("/_app/memory-stores/new")({ component: NewMemoryStorePage })
