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

const taskKey = (token: TurnToken, taskId: number): string => `${token.turn}:${taskId}`

export const makeTurnFence = <TaskResult = never>(store: FenceStore) => {
	const running = new Set<Promise<unknown>>()
	const tasks = new Map<
		string,
		{ readonly controller: AbortController; readonly ended: Promise<TaskResult | undefined> }
	>()
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
	const run = async <A>(
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
		run,
		runTask: (
			token: TurnToken,
			taskId: number,
			caller: AbortSignal,
			work: (signal: AbortSignal) => Promise<TaskResult>,
		): Promise<TaskResult | undefined> => {
			if (caller.aborted || !admits(token)) {
				return Promise.resolve(undefined)
			}
			const key = taskKey(token, taskId)
			const existing = tasks.get(key)
			if (existing !== undefined) {
				return existing.ended
			}
			const controller = new AbortController()
			const ended = run(token, (turn) =>
				Promise.resolve().then(() => {
					const signal = AbortSignal.any([caller, controller.signal, turn])
					return signal.aborted ? undefined : work(signal)
				}),
			).finally(() => {
				if (tasks.get(key)?.ended === ended) {
					tasks.delete(key)
				}
			})
			tasks.set(key, { controller, ended })
			return ended
		},
		stopTask: async (token: TurnToken, taskId: number): Promise<void> => {
			const task = tasks.get(taskKey(token, taskId))
			task?.controller.abort()
			await task?.ended.catch(() => undefined)
		},
		stop: (): void => {
			scope.abort()
		},
		drain,
	}
}
