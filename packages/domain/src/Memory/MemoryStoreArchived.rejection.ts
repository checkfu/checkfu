import * as Domain from "@alchemy.run/domain"
import { MemoryStoreId } from "./MemoryStore.id.ts"

export class MemoryStoreArchivedError extends Domain.Rejection(
	"MemoryStoreArchived",
	{ memory_store_id: MemoryStoreId },
	{ httpApiStatus: 409, description: "Memory store is archived and read-only." },
) {}
