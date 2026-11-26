import { createFileRoute } from "@tanstack/react-router"
import { NewVaultPage } from "../../../pages/vaults.tsx"

export const Route = createFileRoute("/_app/vaults/new")({ component: NewVaultPage })
