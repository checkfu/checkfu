import type * as McpClient from "effect/ai/McpClient"
import type { McpClientError } from "effect/ai/McpClientError"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Hash from "effect/Hash"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"
import * as RcMap from "effect/RcMap"
import type * as Scope from "effect/Scope"
import {
	callMcpTool,
	connectMcp,
	describeMcpFailure,
	listMcpTools,
	mcpClientEnded,
} from "./PiMcpClient.ts"
import { MCP_CALL_TIMEOUT_MS, McpCall, mcpTimedOut, withMcpDeadline } from "./PiMcpTypes.ts"
import type {
	McpCallOutcome,
	McpCallScope,
	McpExit,
	McpFailure,
	McpListOutcome,
	McpToolDescriptor,
} from "./PiMcpTypes.ts"

export interface McpPeer {
	readonly url: string
	readonly exit: McpExit
}

const INTERRUPTED: McpFailure = {
	ok: false,
	message: "The turn was interrupted before this call finished.",
	interrupted: true,
}

const BUSY: McpFailure = {
	ok: false,
	message: "Too many MCP connections are open. Try again shortly.",
	busy: true,
}

class ClientKey implements Equal.Equal {
	readonly key: string
	readonly peer: McpPeer
	readonly client: string
	constructor(key: string, peer: McpPeer) {
		this.key = key
		this.peer = peer
		this.client = `${key}\n${peer.url}`
	}
	[Equal.symbol](that: unknown): boolean {
		return Predicate.hasProperty(that, "client") && that.client === this.client
	}
	[Hash.symbol](): number {
		return Hash.string(this.client)
	}
}

type Lookup =
	| { readonly ok: true; readonly client: McpClient.McpClient }
	| { readonly ok: false; readonly error: McpClientError; readonly started: number }

class McpClients extends Context.Service<
	McpClients,
	RcMap.RcMap<ClientKey, Lookup, Cause.ExceededCapacityError>
>()("checkfu/McpClients") {}

export const makeMcpCaller = (options: {
	readonly capacity: number
	readonly idleMs?: number
	readonly listTimeoutMs?: number
	readonly fetch?: typeof fetch
}) => {
	let lookups = 0
	const runtime = ManagedRuntime.make(
		Layer.effect(
			McpClients,
			RcMap.make({
				lookup: ({ peer }: ClientKey) =>
					Effect.suspend(() => {
						const started = (lookups += 1)
						return connectMcp(peer.url, peer.exit, options.fetch).pipe(
							Effect.map((client): Lookup => ({ ok: true, client })),
							Effect.catch((error) => Effect.succeed<Lookup>({ ok: false, error, started })),
						)
					}),
				capacity: options.capacity,
				idleTimeToLive:
					options.idleMs === undefined ? Duration.infinity : Duration.millis(options.idleMs),
			}),
		),
	)

	const evictIdle = (clients: McpClients["Service"]) =>
		Effect.suspend(() => {
			if (clients.state._tag === "Closed") {
				return Effect.succeed(false)
			}
			let oldest: ClientKey | undefined
			let expiresAt = Number.POSITIVE_INFINITY
			for (const [name, entry] of clients.state.map) {
				if (entry.refCount === 0 && entry.expiresAt < expiresAt) {
					oldest = name
					expiresAt = entry.expiresAt
				}
			}
			return oldest === undefined
				? Effect.succeed(false)
				: Effect.as(RcMap.invalidate(clients, oldest), true)
		})

	const lookup = (clients: McpClients["Service"], name: ClientKey) =>
		RcMap.get(clients, name).pipe(
			Effect.catchIf(Cause.isExceededCapacityError, (full) =>
				Effect.flatMap(evictIdle(clients), (evicted) =>
					evicted ? RcMap.get(clients, name) : Effect.fail(full),
				),
			),
		)

	const acquire = (
		clients: McpClients["Service"],
		name: ClientKey,
		retried = false,
	): Effect.Effect<
		McpClient.McpClient,
		McpClientError | Cause.ExceededCapacityError,
		Scope.Scope
	> =>
		Effect.suspend(() => {
			const asked = lookups
			return Effect.flatMap(lookup(clients, name), (found) => {
				if (found.ok) {
					return Effect.succeed(found.client)
				}
				return Effect.andThen(
					RcMap.invalidate(clients, name),
					found.started <= asked && !retried
						? acquire(clients, name, true)
						: Effect.fail(found.error),
				)
			})
		})

	const closing = (clients: McpClients["Service"], matches: (name: ClientKey) => boolean) =>
		Effect.flatMap(RcMap.keys(clients), (names) =>
			Effect.forEach(Array.from(names).filter(matches), (name) => RcMap.invalidate(clients, name), {
				discard: true,
			}),
		)

	const run = async <A>(
		key: string,
		peer: McpPeer,
		scope: McpCallScope,
		timeoutMs: number | undefined,
		use: (client: McpClient.McpClient) => Effect.Effect<A, McpClientError>,
	): Promise<A | McpFailure> => {
		const name = new ClientKey(key, peer)
		const exit = await runtime.runPromiseExit(
			Effect.gen(function* () {
				const clients = yield* McpClients
				yield* closing(clients, (kept) => kept.key === key && kept.peer.url !== peer.url)
				const request = acquire(clients, name).pipe(
					Effect.flatMap((client) =>
						use(client).pipe(
							Effect.tapError((error) =>
								mcpClientEnded(error) ? RcMap.invalidate(clients, name) : Effect.void,
							),
						),
					),
					Effect.scoped,
				)
				const bounded =
					timeoutMs === undefined
						? request
						: request.pipe(
								Effect.timeoutOption(timeoutMs),
								Effect.map(Option.getOrElse((): A | McpFailure => mcpTimedOut(timeoutMs))),
							)
				return yield* bounded.pipe(
					Effect.catch((error) =>
						Effect.succeed<A | McpFailure>(
							Cause.isExceededCapacityError(error)
								? BUSY
								: {
										ok: false,
										message: describeMcpFailure(error),
										tooLarge: error.reason._tag === "LimitError",
									},
						),
					),
				)
			}).pipe(Effect.provideService(McpCall, scope)),
			scope.signal === undefined ? undefined : { signal: scope.signal },
		)
		if (scope.budget.exceeded) {
			return {
				ok: false,
				message: `The MCP server sent more than the ${scope.budget.limit} bytes this call may read.`,
				tooLarge: true,
			}
		}
		if (Exit.isSuccess(exit)) {
			return exit.value
		}
		return Cause.hasInterruptsOnly(exit.cause)
			? INTERRUPTED
			: { ok: false, message: `The MCP server request failed: ${Cause.pretty(exit.cause)}` }
	}

	return {
		list: (key: string, peer: McpPeer, scope: McpCallScope): Promise<McpListOutcome> =>
			withMcpDeadline(
				async (signal) => {
					const listed = await run(key, peer, { ...scope, signal }, undefined, listMcpTools)
					if (!Option.isOption(listed)) {
						return listed
					}
					return Option.isSome(listed) ? { ok: true, tools: listed.value } : { ok: true }
				},
				scope.signal,
				options.listTimeoutMs,
			),
		call: (
			key: string,
			peer: McpPeer,
			scope: McpCallScope,
			tool: McpToolDescriptor,
			args: Schema.JsonObject,
		): Promise<McpCallOutcome> =>
			run(key, peer, scope, MCP_CALL_TIMEOUT_MS, (client) => callMcpTool(client, tool, args)),
		drop: (matches: (key: string) => boolean): Promise<void> =>
			runtime.runPromise(
				Effect.gen(function* () {
					yield* closing(yield* McpClients, (kept) => matches(kept.key))
				}),
			),
	}
}

export type McpCaller = ReturnType<typeof makeMcpCaller>
