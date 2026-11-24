/** A turn of the session. Turn numbers only grow, so they order the session's turns. */
export interface TurnToken {
	readonly turn: number
}

/** Where a workspace keeps the newest turn it has admitted. */
export interface FenceStore {
	readonly get: () => TurnToken | undefined
	readonly put: (token: TurnToken) => void
}

/**
 * A session keeps one workspace across its turns. A
 * turn that was interrupted or abandoned may still have calls on their way.
 * Once a later turn is admitted, the workspace refuses every call of an older
 * one, and admission waits for the calls already running to finish, so no
 * older turn can change a file after its successor starts.
 */
export const makeTurnFence = (store: FenceStore) => {
	const running = new Set<Promise<unknown>>()
	const isCurrent = (token: TurnToken): boolean => {
		const newest = store.get()
		return newest === undefined || token.turn >= newest.turn
	}
	const drain = async (): Promise<void> => {
		await Promise.allSettled(running)
	}
	return {
		enter: async (token: TurnToken): Promise<boolean> => {
			if (!isCurrent(token)) {
				return false
			}
			store.put(token)
			await drain()
			// A later turn may have entered while this one waited.
			return isCurrent(token)
		},
		/** Waits for every call already running; one that starts later is not waited for. */
		drain,
		/** Runs a call of the given turn, or answers undefined when that turn is no longer current. */
		run: async <A>(token: TurnToken, work: () => Promise<A>): Promise<A | undefined> => {
			if (!isCurrent(token)) {
				return undefined
			}
			const done = work()
			running.add(done)
			try {
				return await done
			} finally {
				running.delete(done)
			}
		},
	}
}
