import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import type * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { asIsoDateTimes } from "./Boundary.ts"
import {
	APIConnectionError,
	APIUserAbortError,
	BadRequestError,
	PaginationCursorCycleError,
	isCheckfuError,
} from "./Errors.ts"
import type { CheckfuConfigError, CheckfuSdkError } from "./Errors.ts"
import { attachPendingReadiness, getPendingReadiness } from "./Runtime.ts"
import type {
	PageEnvelope,
	EffectSdkRuntime,
	IsoDateTimes,
	RequestOptions,
	SessionEventsStreamOptions,
	WithResponse,
} from "./Runtime.ts"

export interface PromiseRequestOptions extends RequestOptions {
	readonly signal?: AbortSignal | undefined
}

export interface PromiseStreamOptions extends SessionEventsStreamOptions {
	readonly signal?: AbortSignal | undefined
}

export interface PromiseWaitForPendingOptions<T> {
	readonly timeout?: Duration.Input | undefined
	readonly initialDelay?: Duration.Input | undefined
	readonly maxDelay?: Duration.Input | undefined
	until?(this: void, resource: T): boolean
	readonly requestOptions?: PromiseRequestOptions | undefined
	readonly signal?: AbortSignal | undefined
}

export interface PromiseWithResponse<T> {
	readonly data: T
	readonly response: Response
	readonly status: number
	readonly headers: Headers
	readonly request_id: string | null
	readonly requestId: string | undefined
}

export interface PromiseSdkRuntime {
	readonly runExit: <A>(
		effect: (runtime: EffectSdkRuntime) => Effect.Effect<A, CheckfuSdkError>,
		signal?: AbortSignal,
	) => Promise<Exit.Exit<A, CheckfuSdkError | CheckfuConfigError>>
	readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>
	readonly runPromiseExit: <A, E>(
		effect: Effect.Effect<A, E>,
	) => Promise<Exit.Exit<A, E | CheckfuConfigError>>
	readonly runFork: <A, E>(
		effect: (runtime: EffectSdkRuntime) => Effect.Effect<A, E>,
	) => Fiber.Fiber<A, E | CheckfuConfigError>
	readonly dispose: () => Promise<void>
}

export const makePromiseSdkRuntime = <R>(
	managed: ManagedRuntime.ManagedRuntime<R, CheckfuConfigError>,
	getEffectRuntime: Effect.Effect<EffectSdkRuntime, never, R>,
): PromiseSdkRuntime => ({
	runExit: (effect, signal) =>
		managed.runPromiseExit(
			Effect.flatMap(getEffectRuntime, effect),
			signal === undefined ? undefined : { signal },
		),
	runPromise: (effect) => managed.runPromise(effect),
	runPromiseExit: (effect) => managed.runPromiseExit(effect),
	runFork: (effect) => managed.runFork(Effect.flatMap(getEffectRuntime, effect)),
	dispose: () => managed.dispose(),
})

const normalizeDatesToJson = (value: unknown): Schema.Json => {
	if (DateTime.isDateTime(value)) {
		return DateTime.formatIso(value)
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value
	}
	if (Array.isArray(value)) {
		return value.map(normalizeDatesToJson)
	}
	if (typeof value === "object") {
		const entries: Array<readonly [string, Schema.Json]> = []
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				entries.push([key, normalizeDatesToJson(entry)])
			}
		}
		return Object.fromEntries(entries)
	}
	return null
}

export const toIsoJson = <T>(value: T): IsoDateTimes<T> => {
	const converted = asIsoDateTimes<T>(normalizeDatesToJson(value))
	const readiness = getPendingReadiness(value)
	if (readiness !== undefined) {
		attachPendingReadiness(converted, readiness)
	}
	return converted
}

export const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true

export const toEffectRequestOptions = (
	options: PromiseRequestOptions | undefined,
): RequestOptions | undefined => {
	if (options === undefined) {
		return undefined
	}
	return {
		...(options.headers === undefined ? {} : { headers: options.headers }),
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
		...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
	}
}

const toWebResponse = async <A>(
	runtime: PromiseSdkRuntime,
	res: WithResponse<A>,
	jsonData: unknown,
): Promise<Response> => {
	const web = HttpClientResponse.toWeb(res.response)
	if (Option.isSome(web) && !web.value.bodyUsed) {
		return web.value
	}
	const headers = Option.isSome(web) ? new Headers(web.value.headers) : toHeaders(res.headers)
	const statusText = Option.isSome(web) ? web.value.statusText : ""
	if (res.status === 204 || res.status === 205 || res.status === 304) {
		return new Response(null, { status: res.status, statusText, headers })
	}
	headers.delete("content-encoding")
	headers.delete("content-length")
	const rawBytes = await runtime.runPromise(Effect.option(res.response.arrayBuffer))
	if (Option.isSome(rawBytes)) {
		return new Response(rawBytes.value.slice(0), {
			status: res.status,
			statusText,
			headers,
		})
	}
	return new Response(JSON.stringify(jsonData), {
		status: res.status,
		statusText,
		headers,
	})
}

const toHeaders = (headers: Readonly<Record<string, string>>): Headers => {
	const out = new Headers()
	for (const [key, value] of Object.entries(headers)) {
		out.set(key, value)
	}
	return out
}

export const unwrapPromiseExit = <A>(exit: Exit.Exit<A, CheckfuSdkError>, aborted: boolean): A => {
	if (Exit.isSuccess(exit)) {
		return exit.value
	}
	if (aborted || Cause.hasInterruptsOnly(exit.cause)) {
		throw new APIUserAbortError({ message: "Request was aborted." })
	}
	const maybeError = Cause.findErrorOption(exit.cause)
	if (Option.isSome(maybeError)) {
		throw maybeError.value
	}
	const squashed = Cause.squash(exit.cause)
	if (isCheckfuError(squashed)) {
		throw squashed
	}
	if (squashed instanceof Error) {
		throw squashed
	}
	throw new APIConnectionError({ message: String(squashed), cause: squashed })
}

export interface LazyPromiseResponse<T> {
	readonly data: T
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly requestId: string | undefined
	readonly buildResponse: () => Promise<Response>
}

export class APIPromise<T> extends Promise<T> {
	readonly #promise: Promise<PromiseWithResponse<T> | LazyPromiseResponse<T>>
	#withResponsePromise: Promise<PromiseWithResponse<T>> | undefined

	static override get [Symbol.species](): PromiseConstructor {
		return Promise
	}

	constructor(promise: Promise<PromiseWithResponse<T> | LazyPromiseResponse<T>>) {
		super((resolve, reject) => {
			void promise.then((res) => {
				resolve(res.data)
			}, reject)
		})
		void this.catch(() => undefined)
		this.#promise = promise
	}

	withResponse(): Promise<PromiseWithResponse<T>> {
		this.#withResponsePromise ??= this.#promise.then(async (res) =>
			"buildResponse" in res
				? {
						data: res.data,
						response: await res.buildResponse(),
						status: res.status,
						headers: toHeaders(res.headers),
						request_id: res.requestId ?? null,
						requestId: res.requestId,
					}
				: res,
		)
		return this.#withResponsePromise
	}

	asResponse(): Promise<Response> {
		return this.withResponse().then((res) => res.response)
	}
}

export class CursorPage<Item> implements AsyncIterable<Item> {
	readonly data: ReadonlyArray<Item>
	readonly next_page: string | null
	readonly #fetchNext: (page: string) => Promise<CursorPage<Item>>
	readonly #requestedPage: string | undefined

	constructor(
		body: PageEnvelope<Item>,
		fetchNext: (page: string) => Promise<CursorPage<Item>>,
		requestedPage: string | undefined,
	) {
		this.data = body.data
		this.next_page = body.next_page
		this.#fetchNext = fetchNext
		this.#requestedPage = requestedPage
	}

	hasNextPage(): boolean {
		return this.next_page !== null
	}

	async getNextPage(): Promise<CursorPage<Item>> {
		if (this.next_page === null) {
			throw new BadRequestError({
				status: 400,
				message: "No next page expected. Check `.hasNextPage()` before calling `.getNextPage()`.",
			})
		}
		return this.#fetchNext(this.next_page)
	}

	async *iterPages(): AsyncGenerator<CursorPage<Item>, void, undefined> {
		const seen = new Set<string>(this.#requestedPage === undefined ? [] : [this.#requestedPage])
		let current: CursorPage<Item> = this
		yield current
		while (current.next_page !== null) {
			const next = current.next_page
			if (seen.has(next)) {
				throw new PaginationCursorCycleError({
					message: `Pagination cursor did not advance (${current.#requestedPage} -> ${next}).`,
				})
			}
			seen.add(next)
			current = await current.getNextPage()
			yield current
		}
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Item, void, undefined> {
		for await (const page of this.iterPages()) {
			for (const item of page.data) {
				yield item
			}
		}
	}
}

export class PagePromise<
	PageClass extends AsyncIterable<Item>,
	Item = PageClass extends AsyncIterable<infer Entry> ? Entry : never,
>
	extends APIPromise<PageClass>
	implements AsyncIterable<Item>
{
	async *[Symbol.asyncIterator](): AsyncGenerator<Item, void, undefined> {
		const firstPage = await this
		for await (const item of firstPage) {
			yield item
		}
	}
}

export class EventStream<T> implements AsyncIterable<T> {
	readonly controller: AbortController
	readonly #nextItem: () => Promise<IteratorResult<T, undefined>>
	readonly #close: () => Promise<void>
	#consumed = false

	constructor(
		controller: AbortController,
		nextItem: () => Promise<IteratorResult<T, undefined>>,
		close: () => Promise<void>,
	) {
		this.controller = controller
		this.#nextItem = nextItem
		this.#close = close
	}

	[Symbol.asyncIterator](): AsyncIterator<T, undefined> {
		if (this.#consumed) {
			throw new APIConnectionError({
				message: "Cannot iterate over a consumed EventStream; streams can only be read once.",
				transient: false,
			})
		}
		this.#consumed = true
		return {
			next: () => this.#nextItem(),
			return: async () => {
				await this.#close()
				return { value: undefined, done: true }
			},
		}
	}

	tee(): readonly [EventStream<T>, EventStream<T>] {
		const source = this[Symbol.asyncIterator]()
		const controller = this.controller
		const leftQueue: Array<Promise<IteratorResult<T, undefined>>> = []
		const rightQueue: Array<Promise<IteratorResult<T, undefined>>> = []
		let leftClosed = false
		let rightClosed = false

		const pullIntoBoth = (): void => {
			const step = source.next()
			void step.catch(() => undefined)
			if (!leftClosed) {
				leftQueue.push(step)
			}
			if (!rightClosed) {
				rightQueue.push(step)
			}
		}

		const makeBranch = (
			queue: Array<Promise<IteratorResult<T, undefined>>>,
			isLeft: boolean,
		): EventStream<T> => {
			let branchClosed = false
			const nextBranch = async (): Promise<IteratorResult<T, undefined>> => {
				if (branchClosed) {
					return { value: undefined, done: true }
				}
				if (controller.signal.aborted) {
					queue.length = 0
					throw new APIUserAbortError({ message: "Event stream was aborted." })
				}
				if (queue.length === 0) {
					pullIntoBoth()
				}
				const head = queue.shift()
				if (head === undefined) {
					return { value: undefined, done: true }
				}
				const result = await head
				if (branchClosed) {
					return { value: undefined, done: true }
				}
				if (controller.signal.aborted) {
					queue.length = 0
					throw new APIUserAbortError({ message: "Event stream was aborted." })
				}
				return result
			}
			const closeBranch = async (): Promise<void> => {
				if (branchClosed) {
					return
				}
				branchClosed = true
				if (isLeft) {
					leftClosed = true
					leftQueue.length = 0
				} else {
					rightClosed = true
					rightQueue.length = 0
				}
				if (leftClosed && rightClosed) {
					await source.return?.()
				}
			}
			return new EventStream(controller, nextBranch, closeBranch)
		}

		return [makeBranch(leftQueue, true), makeBranch(rightQueue, false)] as const
	}

	toReadableStream(): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder()
		const iterator = this[Symbol.asyncIterator]()
		return new ReadableStream<Uint8Array>({
			async pull(streamController) {
				try {
					const step = await iterator.next()
					if (step.done) {
						streamController.close()
						return
					}
					streamController.enqueue(encoder.encode(`${JSON.stringify(step.value)}\n`))
				} catch (error) {
					streamController.error(error)
				}
			},
			async cancel() {
				await iterator.return?.()
			},
		})
	}

	toEventReadableStream(): ReadableStream<T> {
		const iterator = this[Symbol.asyncIterator]()
		return new ReadableStream<T>({
			async pull(streamController) {
				try {
					const step = await iterator.next()
					if (step.done) {
						streamController.close()
						return
					}
					streamController.enqueue(step.value)
				} catch (error) {
					streamController.error(error)
				}
			},
			async cancel() {
				await iterator.return?.()
			},
		})
	}
}

export class EventStreamPromise<T> implements Promise<EventStream<T>>, AsyncIterable<T> {
	readonly #promise: Promise<EventStream<T>>

	constructor(promise: Promise<EventStream<T>>) {
		this.#promise = promise
	}

	then<TResult1 = EventStream<T>, TResult2 = never>(
		onfulfilled?: ((value: EventStream<T>) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.#promise.then(onfulfilled, onrejected)
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<EventStream<T> | TResult> {
		return this.#promise.catch(onrejected)
	}

	finally(onfinally?: (() => void) | null): Promise<EventStream<T>> {
		return this.#promise.finally(onfinally)
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
		const stream = await this.#promise
		for await (const event of stream) {
			yield event
		}
	}

	get [Symbol.toStringTag](): string {
		return "EventStreamPromise"
	}
}

export const executeUnaryPromise = <A>(
	runtime: PromiseSdkRuntime,
	requestOptions: PromiseRequestOptions | undefined,
	run: (
		effectRuntime: EffectSdkRuntime,
		effectOpts: RequestOptions | undefined,
	) => Effect.Effect<WithResponse<A>, CheckfuSdkError>,
): APIPromise<IsoDateTimes<A>> => {
	const signal = requestOptions?.signal
	const effectOpts = toEffectRequestOptions(requestOptions)
	const promise = (async (): Promise<LazyPromiseResponse<IsoDateTimes<A>>> => {
		if (isSignalAborted(signal)) {
			throw new APIUserAbortError({ message: "Request was aborted." })
		}
		const exit = await runtime.runExit((effectRuntime) => run(effectRuntime, effectOpts), signal)
		const raw = unwrapPromiseExit(exit, isSignalAborted(signal))
		const data = toIsoJson(raw.data)
		return {
			data,
			status: raw.status,
			headers: raw.headers,
			requestId: raw.requestId,
			buildResponse: () => toWebResponse(runtime, raw, data),
		}
	})()
	return new APIPromise(promise)
}

export const executePaginatedPromise = <Item>(
	runtime: PromiseSdkRuntime,
	initialPage: string | undefined,
	requestOptions: PromiseRequestOptions | undefined,
	runPage: (
		effectRuntime: EffectSdkRuntime,
		token: string | undefined,
		effectOpts: RequestOptions | undefined,
	) => Effect.Effect<WithResponse<PageEnvelope<Item>>, CheckfuSdkError>,
): PagePromise<CursorPage<IsoDateTimes<Item>>, IsoDateTimes<Item>> => {
	const signal = requestOptions?.signal
	const effectOpts = toEffectRequestOptions(requestOptions)

	const fetchPageRaw = async (
		token: string | undefined,
	): Promise<{
		readonly page: CursorPage<IsoDateTimes<Item>>
		readonly body: PageEnvelope<IsoDateTimes<Item>>
		readonly raw: WithResponse<PageEnvelope<Item>>
	}> => {
		if (isSignalAborted(signal)) {
			throw new APIUserAbortError({ message: "Request was aborted." })
		}
		const exit = await runtime.runExit(
			(effectRuntime) => runPage(effectRuntime, token, effectOpts),
			signal,
		)
		const raw = unwrapPromiseExit(exit, isSignalAborted(signal))
		const body = { ...raw.data, data: raw.data.data.map(toIsoJson) }
		const page = new CursorPage<IsoDateTimes<Item>>(
			body,
			async (next) => (await fetchPageRaw(next)).page,
			token,
		)
		return { page, body, raw }
	}

	const firstPagePromise = fetchPageRaw(initialPage).then(
		({ page, body, raw }): LazyPromiseResponse<CursorPage<IsoDateTimes<Item>>> => ({
			data: page,
			status: raw.status,
			headers: raw.headers,
			requestId: raw.requestId,
			buildResponse: () => toWebResponse(runtime, raw, body),
		}),
	)

	return new PagePromise(firstPagePromise)
}

export const executeSseStreamPromise = <Event>(
	runtime: PromiseSdkRuntime,
	streamOptions: PromiseStreamOptions | undefined,
	buildStream: (
		effectRuntime: EffectSdkRuntime,
		effectStreamOpts: SessionEventsStreamOptions,
	) => Stream.Stream<Event, CheckfuSdkError>,
): EventStreamPromise<IsoDateTimes<Event>> => {
	const promise = (async (): Promise<EventStream<IsoDateTimes<Event>>> => {
		const externalSignal = streamOptions?.signal
		if (isSignalAborted(externalSignal)) {
			throw new APIUserAbortError({ message: "Request was aborted." })
		}

		const controller = new AbortController()
		const onExternalAbort = (): void => {
			controller.abort(externalSignal?.reason)
		}
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

		const queue = await runtime.runPromise(Queue.bounded<Event, CheckfuSdkError | Cause.Done>(64))
		const opened = await runtime.runPromise(Deferred.make<void, CheckfuSdkError>())
		let closedByConsumer = false
		let interrupted = false

		const cleanup = (): void => {
			externalSignal?.removeEventListener("abort", onExternalAbort)
		}

		if (controller.signal.aborted) {
			cleanup()
			throw new APIUserAbortError({ message: "Request was aborted." })
		}

		const fiber = runtime.runFork((effectRuntime) => {
			const { signal: _ignoredSignal, ...effectStreamOpts } = streamOptions ?? {}
			return buildStream(effectRuntime, {
				...effectStreamOpts,
				onOpen: (status) =>
					Effect.gen(function* () {
						if (effectStreamOpts.onOpen !== undefined) {
							yield* effectStreamOpts.onOpen(status)
						}
						yield* Deferred.succeed(opened, undefined)
					}),
			}).pipe(
				Stream.runForEach((event) => Queue.offer(queue, event)),
				Effect.onExit((exit) => {
					if (Exit.isSuccess(exit)) {
						return Deferred.succeed(opened, undefined).pipe(
							Effect.andThen(Queue.end(queue)),
							Effect.ignore,
						)
					}
					if (Cause.hasInterruptsOnly(exit.cause)) {
						const abortErr = new APIUserAbortError({ message: "Event stream was aborted." })
						return Deferred.fail(opened, abortErr).pipe(
							Effect.andThen(Queue.fail(queue, abortErr)),
							Effect.ignore,
						)
					}
					return Deferred.failCause(opened, exit.cause).pipe(
						Effect.andThen(Queue.failCause(queue, exit.cause)),
						Effect.ignore,
					)
				}),
				Effect.ignore,
				Effect.catchDefect(() => Effect.void),
			)
		})

		const abortStream = (): void => {
			if (interrupted) {
				return
			}
			interrupted = true
			cleanup()
			const abortErr = new APIUserAbortError({ message: "Event stream was aborted." })
			runtime.runFork(() =>
				Deferred.fail(opened, abortErr).pipe(
					Effect.andThen(Queue.failCause(queue, Cause.fail(abortErr))),
					Effect.andThen(Queue.shutdown(queue)),
					Effect.andThen(Fiber.interrupt(fiber)),
					Effect.ignore,
				),
			)
		}

		controller.signal.addEventListener("abort", abortStream, { once: true })
		if (controller.signal.aborted) {
			abortStream()
		}

		const openExit = await runtime.runPromiseExit(Deferred.await(opened))
		if (Exit.isFailure(openExit)) {
			cleanup()
			controller.signal.removeEventListener("abort", abortStream)
			unwrapPromiseExit(openExit, controller.signal.aborted)
		}

		const closeStream = async (): Promise<void> => {
			if (closedByConsumer) {
				return
			}
			closedByConsumer = true
			interrupted = true
			cleanup()
			controller.signal.removeEventListener("abort", abortStream)
			controller.abort()
			await runtime.runPromise(
				Queue.end(queue).pipe(
					Effect.andThen(Queue.shutdown(queue)),
					Effect.andThen(Fiber.interrupt(fiber)),
					Effect.ignore,
				),
			)
		}

		const nextItem = async (): Promise<IteratorResult<IsoDateTimes<Event>, undefined>> => {
			if (closedByConsumer) {
				cleanup()
				controller.signal.removeEventListener("abort", abortStream)
				return { value: undefined, done: true }
			}
			if (controller.signal.aborted) {
				cleanup()
				controller.signal.removeEventListener("abort", abortStream)
				throw new APIUserAbortError({ message: "Event stream was aborted." })
			}
			const takeExit = await runtime.runPromiseExit(Queue.take(queue))
			if (closedByConsumer) {
				cleanup()
				controller.signal.removeEventListener("abort", abortStream)
				return { value: undefined, done: true }
			}
			if (controller.signal.aborted) {
				cleanup()
				controller.signal.removeEventListener("abort", abortStream)
				throw new APIUserAbortError({ message: "Event stream was aborted." })
			}
			if (Exit.isSuccess(takeExit)) {
				return { value: toIsoJson(takeExit.value), done: false }
			}
			cleanup()
			controller.signal.removeEventListener("abort", abortStream)
			if (closedByConsumer) {
				return { value: undefined, done: true }
			}
			if (controller.signal.aborted) {
				throw new APIUserAbortError({ message: "Event stream was aborted." })
			}
			const err = Cause.findErrorOption(takeExit.cause)
			if (Option.isSome(err)) {
				if (Cause.isDone(err.value)) {
					return { value: undefined, done: true }
				}
				throw err.value
			}
			const squashed = Cause.squash(takeExit.cause)
			if (Cause.isDone(squashed)) {
				return { value: undefined, done: true }
			}
			if (isCheckfuError(squashed)) {
				throw squashed
			}
			if (squashed instanceof Error) {
				throw squashed
			}
			throw new APIConnectionError({ message: String(squashed), cause: squashed })
		}

		return new EventStream(controller, nextItem, closeStream)
	})()

	return new EventStreamPromise(promise)
}
