import { createFileRoute } from "@tanstack/react-router"
import { MemoryStorePage } from "../../../../pages/memory.tsx"
import { memoriesQuery, memoryStoreQuery } from "../../../../queries.ts"

export const Route = createFileRoute("/_app/memory-stores/$memoryStoreId/")({
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(memoryStoreQuery(params.memoryStoreId)),
			context.queryClient.ensureQueryData(memoriesQuery(params.memoryStoreId)),
		]),
	component: MemoryStorePage,
})
