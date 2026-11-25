export interface TurnToken {
	readonly turn: number
}

export interface FenceStore {
	readonly get: () => TurnToken | undefined
	readonly put: (token: TurnToken) => void
}

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
			return isCurrent(token)
		},
		drain,
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
