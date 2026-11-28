import { AsyncLocalStorage } from "node:async_hooks"

const current = new AsyncLocalStorage<AbortSignal>()

export const withCallSignal = <A>(signal: AbortSignal, work: () => Promise<A>): Promise<A> =>
	current.run(signal, work)

export const callSignal = (signal?: AbortSignal): AbortSignal | undefined => {
	const call = current.getStore()
	return call === undefined || call === signal
		? signal
		: signal === undefined
			? call
			: AbortSignal.any([call, signal])
}

export const throwIfCallStopped = (): void => {
	current.getStore()?.throwIfAborted()
}
