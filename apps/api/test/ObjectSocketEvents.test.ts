import { describe, expect, it } from "@effect/vitest"
import type { Subscription } from "@alchemy.run/domain/Platform"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import { SOCKET_BUFFER_BYTES, objectSocketChanges } from "../src/Http/ObjectSocketEvents.ts"

type Listener = (event: Socket.WebSocketEvent) => void

const pushingSocket = (frames: ReadonlyArray<string>) => {
	const socket = {
		readyState: 1,
		closes: [] as Array<number | undefined>,
		accept: () => {},
		addEventListener: (type: string, listener: Listener) => {
			if (type === "message") {
				for (const data of frames) {
					listener({ data })
				}
			}
		},
		removeEventListener: () => {},
		send: () => {},
		close: (code?: number) => {
			socket.closes.push(code)
		},
	}
	return socket
}

const answering =
	(socket: ReturnType<typeof pushingSocket>, subscriptions: Array<Subscription> = []) =>
	(_key: string, subscription: Subscription) =>
		Effect.sync(() => {
			subscriptions.push(subscription)
			return HttpServerResponse.raw({ webSocket: socket }, { status: 101 })
		})

const stateFrame = (bytes: number, cursor = 1, archivedAt: string | null = null) =>
	JSON.stringify({
		_tag: "Chunk",
		values: [{ cursor, state: { archived_at: archivedAt, pad: "x".repeat(bytes) } }],
	})

describe("objectSocketChanges", () => {
	it.effect("watches the key's head, so no frame replays a backlog", () =>
		Effect.gen(function* () {
			const subscriptions: Array<Subscription> = []
			const socket = pushingSocket([
				stateFrame(10, 6),
				stateFrame(10, 7, "2026-11-24T00:00:00Z"),
				JSON.stringify({ _tag: "Exit" }),
			])
			const ticks = yield* objectSocketChanges(answering(socket, subscriptions), "session").pipe(
				Stream.runCollect,
			)
			expect(ticks).toEqual([
				{ seq: 6, archived: false },
				{ seq: 7, archived: true },
			])
			expect(subscriptions).toEqual([expect.objectContaining({ mode: "watch", cursor: 0 })])
		}),
	)

	it.effect("ends the stream when a reader falls a whole buffer behind", () =>
		Effect.gen(function* () {
			const frames = Array.from({ length: 20 }, () => stateFrame(100 * 1024))
			const socket = pushingSocket(frames)
			const ticks = yield* objectSocketChanges(answering(socket), "session").pipe(Stream.runCollect)
			const delivered = Math.floor(SOCKET_BUFFER_BYTES / (frames[0]?.length ?? 1)) + 1
			expect(ticks).toHaveLength(delivered)
			expect(delivered).toBeLessThan(frames.length)
			expect(socket.closes[0]).toBe(1008)
		}),
	)

	it.live("stops waiting for the socket upgrade when the reader goes away", () =>
		Effect.gen(function* () {
			const fiber = yield* objectSocketChanges(() => Effect.never, "session").pipe(
				Stream.runDrain,
				Effect.forkDetach,
			)
			yield* Effect.sleep(Duration.millis(20))
			yield* Effect.forkDetach(Fiber.interrupt(fiber))
			yield* Fiber.await(fiber).pipe(
				Effect.timeoutOrElse({
					duration: Duration.seconds(2),
					orElse: () => Effect.die(new Error("the pending upgrade ignored the interrupt")),
				}),
			)
		}),
	)
})
