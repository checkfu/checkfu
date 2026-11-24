import { useState } from "react"
import { useAction } from "./use-action.ts"

interface Page<T> {
	readonly data: ReadonlyArray<T>
	readonly next_cursor: string | null
}

export function useMorePages<T>(first: Page<T>, load: (after: string) => Promise<Page<T>>) {
	const [later, setLater] = useState<ReadonlyArray<Page<T>>>([])
	const cursor = (later.at(-1) ?? first).next_cursor
	const more = useAction(async () => {
		if (cursor !== null) {
			const page = await load(cursor)
			setLater((loaded) => [...loaded, page])
		}
	})
	return {
		items: [first, ...later].flatMap((page) => page.data),
		pending: more.pending,
		error: more.error,
		more: cursor === null ? null : () => more.run(),
	}
}
