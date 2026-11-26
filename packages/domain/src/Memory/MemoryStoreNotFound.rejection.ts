import * as Domain from "@alchemy.run/domain"
import { MemoryStoreId } from "./MemoryStore.id.ts"

export class MemoryStoreNotFound extends Domain.Rejection(
	"MemoryStoreNotFound",
	{ memory_store_id: MemoryStoreId },
	{ httpApiStatus: 404, description: "Memory store does not exist." },
) {}
