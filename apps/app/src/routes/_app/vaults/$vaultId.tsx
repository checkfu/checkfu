import { createFileRoute } from "@tanstack/react-router"
import { VaultPage } from "../../../pages/vaults.tsx"
import { credentialPages, vaultQuery } from "../../../queries.ts"

export const Route = createFileRoute("/_app/vaults/$vaultId")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(vaultQuery(params.vaultId)),
			context.queryClient.ensureInfiniteQueryData(credentialPages(params.vaultId)),
		]),
	component: VaultPage,
})
