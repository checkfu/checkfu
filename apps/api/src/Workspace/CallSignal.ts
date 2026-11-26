import { AsyncLocalStorage } from "node:async_hooks"

const current = new AsyncLocalStorage<AbortSignal>()

export const withCallSignal = <A>(signal: AbortSignal, work: () => Promise<A>): Promise<A> =>
	current.run(signal, work)

export const throwIfCallStopped = (): void => {
	current.getStore()?.throwIfAborted()
}
