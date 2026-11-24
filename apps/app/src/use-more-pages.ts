import { useState } from "react"

interface Page<T> {
	readonly data: ReadonlyArray<T>
	readonly next_cursor: string | null
}

export function useMorePages<T>(first: Page<T>, load: (after: string) => Promise<Page<T>>) {
	const [later, setLater] = useState<ReadonlyArray<Page<T>>>([])
	const [pending, setPending] = useState(false)
	const last = later.at(-1) ?? first
	const cursor = last.next_cursor
	return {
		items: [first, ...later].flatMap((page) => page.data),
		pending,
		more:
			cursor === null
				? null
				: () => {
						setPending(true)
						load(cursor).then(
							(page) => {
								setLater((loaded) => [...loaded, page])
								setPending(false)
							},
							() => setPending(false),
						)
					},
	}
}
