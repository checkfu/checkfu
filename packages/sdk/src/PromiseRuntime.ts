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
import {
	APIConnectionError,
	APIUserAbortError,
	BadRequestError,
	PaginationCursorCycleError,
	isCheckfuError,
} from "./Errors.ts"
import type { CheckfuConfigError, CheckfuSdkError } from "./Errors.ts"
import type {
	CursorPageEnvelope,
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

/**
 * Converts Effect `DateTime.Utc` fields to ISO-8601 strings across any decoded
 * wire response so plain TypeScript callers of the Promise client receive plain
 * JSON objects.
 */
export const toIsoJson = <T>(value: T): IsoDateTimes<T> =>
	// Boundary conversion: `normalizeDatesToJson` preserves all wire keys/primitives
	// and replaces every `DateTime.Utc` instance with its ISO-8601 string, matching `IsoDateTimes<T>`.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	normalizeDatesToJson(value) as IsoDateTimes<T>

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

const toWebResponse = <A>(res: WithResponse<A>, jsonData: unknown): Response => {
	const web = HttpClientResponse.toWeb(res.response)
	if (Option.isSome(web)) {
		return web.value
	}
	const headers = new Headers()
	for (const [key, value] of Object.entries(res.headers)) {
		headers.set(key, value)
	}
	return new Response(JSON.stringify(jsonData), {
		status: res.status,
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

/**
 * Awaitable API result supporting `.withResponse()` and `.asResponse()` over a
 * single underlying HTTP exchange.
 */
export class APIPromise<T> extends Promise<T> {
	readonly #promise: Promise<PromiseWithResponse<T>>

	static override get [Symbol.species](): PromiseConstructor {
		return Promise
	}

	constructor(promise: Promise<PromiseWithResponse<T>>) {
		super((resolve, reject) => {
			void promise.then((res) => {
				resolve(res.data)
			}, reject)
		})
		// Prevent unhandled rejection when caller consumes via `.withResponse()` or `.asResponse()`
		// instead of awaiting `this` directly; awaiting either view still rejects with the exact error.
		void this.catch(() => undefined)
		this.#promise = promise
	}

	withResponse(): Promise<PromiseWithResponse<T>> {
		return this.#promise
	}

	asResponse(): Promise<Response> {
		return this.#promise.then((res) => res.response)
	}
}

export class CursorPage<
	Item,
	Cursor extends string | number = number,
> implements AsyncIterable<Item> {
	readonly data: ReadonlyArray<Item>
	readonly has_more: boolean
	readonly next_cursor: Cursor | null
	readonly #fetchNext: (after: Cursor) => Promise<CursorPage<Item, Cursor>>
	readonly #requestedAfter: Cursor | undefined
	readonly #order: "asc" | "desc"

	constructor(
		body: CursorPageEnvelope<Item, Cursor>,
		fetchNext: (after: Cursor) => Promise<CursorPage<Item, Cursor>>,
		requestedAfter: Cursor | undefined,
		order: "asc" | "desc",
	) {
		this.data = body.data
		this.has_more = body.has_more
		this.next_cursor = body.next_cursor
		this.#fetchNext = fetchNext
		this.#requestedAfter = requestedAfter
		this.#order = order
	}

	hasNextPage(): boolean {
		return this.has_more && this.next_cursor !== null
	}

	async getNextPage(): Promise<CursorPage<Item, Cursor>> {
		if (!this.hasNextPage() || this.next_cursor === null) {
			throw new BadRequestError({
				status: 400,
				message:
					"No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.",
			})
		}
		return this.#fetchNext(this.next_cursor)
	}

	async *iterPages(): AsyncGenerator<CursorPage<Item, Cursor>, void, undefined> {
		const seenCursors = new Set<Cursor>()
		if (this.#requestedAfter !== undefined) {
			seenCursors.add(this.#requestedAfter)
		}
		let current: CursorPage<Item, Cursor> = this
		let prevCursor = this.#requestedAfter
		yield current
		while (current.hasNextPage() && current.next_cursor !== null) {
			const nextAfter = current.next_cursor
			const repeated = seenCursors.has(nextAfter)
			const regressed =
				typeof prevCursor === "number" &&
				typeof nextAfter === "number" &&
				(this.#order === "asc" ? nextAfter <= prevCursor : nextAfter >= prevCursor)
			if (repeated || regressed) {
				throw new PaginationCursorCycleError({
					message: `Pagination cursor did not advance (${String(prevCursor)} -> ${String(nextAfter)}).`,
				})
			}
			seenCursors.add(nextAfter)
			prevCursor = nextAfter
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

	/**
	 * Splits the stream into two independent `EventStream`s that both receive all
	 * subsequent events from the single underlying connection.
	 */
	tee(): readonly [EventStream<T>, EventStream<T>] {
		const source = this[Symbol.asyncIterator]()
		const leftQueue: Array<Promise<IteratorResult<T, undefined>>> = []
		const rightQueue: Array<Promise<IteratorResult<T, undefined>>> = []
		let closedBranches = 0

		const pullIntoBoth = (): void => {
			const step = source.next()
			leftQueue.push(step)
			rightQueue.push(step)
		}

		const makeBranch = (queue: Array<Promise<IteratorResult<T, undefined>>>): EventStream<T> => {
			let branchClosed = false
			const nextBranch = (): Promise<IteratorResult<T, undefined>> => {
				if (branchClosed) {
					return Promise.resolve({ value: undefined, done: true })
				}
				if (queue.length === 0) {
					pullIntoBoth()
				}
				const head = queue.shift()
				return head ?? Promise.resolve({ value: undefined, done: true })
			}
			const closeBranch = async (): Promise<void> => {
				if (branchClosed) {
					return
				}
				branchClosed = true
				closedBranches += 1
				if (closedBranches >= 2) {
					await source.return?.()
				}
			}
			return new EventStream(this.controller, nextBranch, closeBranch)
		}

		return [makeBranch(leftQueue), makeBranch(rightQueue)] as const
	}

	/**
	 * Returns a Web `ReadableStream` of newline-delimited UTF-8 JSON bytes suitable
	 * for streaming directly in an HTTP `Response`.
	 */
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

	/**
	 * Returns a Web `ReadableStream` of decoded event objects.
	 */
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
	const promise = (async (): Promise<PromiseWithResponse<IsoDateTimes<A>>> => {
		if (isSignalAborted(signal)) {
			throw new APIUserAbortError({ message: "Request was aborted." })
		}
		const exit = await runtime.runExit((effectRuntime) => run(effectRuntime, effectOpts), signal)
		const raw = unwrapPromiseExit(exit, isSignalAborted(signal))
		const data = toIsoJson(raw.data)
		return {
			data,
			response: toWebResponse(raw, data),
			status: raw.status,
			headers: toHeaders(raw.headers),
			request_id: raw.requestId ?? null,
			requestId: raw.requestId,
		}
	})()
	return new APIPromise(promise)
}

export const executePaginatedPromise = <Item, Cursor extends string | number = number>(
	runtime: PromiseSdkRuntime,
	initialAfter: Cursor | undefined,
	order: "asc" | "desc",
	requestOptions: PromiseRequestOptions | undefined,
	runPage: (
		effectRuntime: EffectSdkRuntime,
		after: Cursor | undefined,
		effectOpts: RequestOptions | undefined,
	) => Effect.Effect<WithResponse<CursorPageEnvelope<Item, Cursor>>, CheckfuSdkError>,
): PagePromise<CursorPage<IsoDateTimes<Item>, Cursor>, IsoDateTimes<Item>> => {
	const signal = requestOptions?.signal
	const effectOpts = toEffectRequestOptions(requestOptions)

	const fetchPage = (
		after: Cursor | undefined,
	): Promise<PromiseWithResponse<CursorPage<IsoDateTimes<Item>, Cursor>>> =>
		(async () => {
			if (isSignalAborted(signal)) {
				throw new APIUserAbortError({ message: "Request was aborted." })
			}
			const exit = await runtime.runExit(
				(effectRuntime) => runPage(effectRuntime, after, effectOpts),
				signal,
			)
			const raw = unwrapPromiseExit(exit, isSignalAborted(signal))
			const body: CursorPageEnvelope<IsoDateTimes<Item>, Cursor> = {
				data: raw.data.data.map(toIsoJson),
				has_more: raw.data.has_more,
				next_cursor: raw.data.next_cursor,
			}
			const page = new CursorPage<IsoDateTimes<Item>, Cursor>(
				body,
				async (nextAfter) => {
					const nextRes = await fetchPage(nextAfter)
					return nextRes.data
				},
				after,
				order,
			)
			return {
				data: page,
				response: toWebResponse(raw, body),
				status: raw.status,
				headers: toHeaders(raw.headers),
				request_id: raw.requestId ?? null,
				requestId: raw.requestId,
			}
		})()

	return new PagePromise(fetchPage(initialAfter))
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
				Effect.andThen(Deferred.succeed(opened, undefined)),
				Effect.andThen(Queue.end(queue)),
				Effect.catch((error) =>
					Deferred.fail(opened, error).pipe(Effect.andThen(Queue.fail(queue, error))),
				),
				Effect.onInterrupt(() => {
					const abortErr = new APIUserAbortError({ message: "Event stream was aborted." })
					return Deferred.fail(opened, abortErr).pipe(
						Effect.andThen(Queue.fail(queue, abortErr)),
						Effect.ignore,
					)
				}),
			)
		})

		const cleanup = (): void => {
			externalSignal?.removeEventListener("abort", onExternalAbort)
		}

		const abortStream = (): void => {
			if (interrupted) {
				return
			}
			interrupted = true
			cleanup()
			runtime.runFork(() => Fiber.interrupt(fiber))
		}

		controller.signal.addEventListener("abort", abortStream, { once: true })

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
			await runtime.runPromise(Fiber.interrupt(fiber))
		}

		const nextItem = async (): Promise<IteratorResult<IsoDateTimes<Event>, undefined>> => {
			const takeExit = await runtime.runPromiseExit(Queue.take(queue))
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
