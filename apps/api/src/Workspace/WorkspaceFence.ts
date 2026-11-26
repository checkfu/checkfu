import type { TurnToken } from "./WorkspaceShapes.ts"

export type { TurnToken } from "./WorkspaceShapes.ts"

export interface FencedTurn {
	readonly turn: number
	readonly interrupted?: true
}

export interface FenceStore {
	readonly get: () => FencedTurn | undefined
	readonly put: (turn: FencedTurn) => void
}

export const makeTurnFence = (store: FenceStore) => {
	const running = new Set<Promise<unknown>>()
	let scope = new AbortController()
	const isNewer = (token: TurnToken): boolean => {
		const newest = store.get()
		return newest === undefined || token.turn > newest.turn
	}
	const admits = (token: TurnToken): boolean => {
		const newest = store.get()
		return (
			newest === undefined ||
			token.turn > newest.turn ||
			(token.turn === newest.turn && newest.interrupted !== true)
		)
	}
	const advance = (token: TurnToken): void => {
		if (isNewer(token)) {
			scope.abort()
			scope = new AbortController()
			store.put({ turn: token.turn })
		}
	}
	const drain = async (): Promise<void> => {
		await Promise.allSettled(running)
	}
	return {
		enter: async (token: TurnToken): Promise<boolean> => {
			if (!admits(token)) {
				return false
			}
			advance(token)
			await drain()
			return admits(token)
		},
		interrupt: (token: TurnToken): void => {
			if (isNewer(token) || store.get()?.turn === token.turn) {
				store.put({ turn: token.turn, interrupted: true })
				scope.abort()
			}
		},
		run: async <A>(
			token: TurnToken,
			work: (signal: AbortSignal) => Promise<A>,
		): Promise<A | undefined> => {
			if (!admits(token)) {
				return undefined
			}
			advance(token)
			const done = work(scope.signal)
			running.add(done)
			try {
				return await done
			} finally {
				running.delete(done)
			}
		},
		stop: (): void => {
			scope.abort()
		},
		drain,
	}
}
