/** Where a workspace keeps the newest harness generation it has served. */
export interface FenceStore {
	readonly get: () => number | undefined
	readonly put: (generation: number) => void
}

/**
 * A session keeps one workspace across harness generations. When a turn is
 * abandoned, its harness may still be running tool calls while the next
 * generation starts. The workspace serves the newest generation it has seen
 * and refuses every older one, so a late call cannot change what its
 * successor reads.
 */
export const admitGeneration = (store: FenceStore, generation: number): boolean => {
	const newest = store.get() ?? 0
	if (generation < newest) {
		return false
	}
	if (generation > newest) {
		store.put(generation)
	}
	return true
}
