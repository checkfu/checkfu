import { FileBytes } from "@checkfu/domain/File/FileBytes.external"
import * as Effect from "effect/Effect"
import { FileStore } from "./FileStore.ts"

export const FileBytesLive = FileBytes.toLayer(
	Effect.map(FileStore, (store) => ({
		purge: ({ file_id }) => Effect.orDie(store.purge(file_id)),
		release: ({ file_id, reservation }) => Effect.orDie(store.release(file_id, reservation)),
	})),
)
