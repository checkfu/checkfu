import { createFileRoute } from "@tanstack/react-router"
import { MemoryPage } from "../../../../../pages/memory.tsx"
import { memoryQuery, memoryStoreQuery } from "../../../../../queries.ts"

export const Route = createFileRoute("/_app/memory-stores/$memoryStoreId/memories/$memoryId")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(memoryStoreQuery(params.memoryStoreId)),
			context.queryClient.ensureQueryData(memoryQuery(params.memoryStoreId, params.memoryId)),
		]),
	component: MemoryPage,
})
