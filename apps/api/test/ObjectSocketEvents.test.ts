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

/** An accepted Durable Object socket that sends `frames` the moment the reader listens. */
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

const stateFrame = (bytes: number) =>
	JSON.stringify({ _tag: "Chunk", values: [{ cursor: 1, state: { pad: "x".repeat(bytes) } }] })

describe("objectSocketChanges", () => {
	it.effect("watches the key's state, so no frame replays a backlog", () =>
		Effect.gen(function* () {
			const subscriptions: Array<Subscription> = []
			const socket = pushingSocket([
				stateFrame(10),
				stateFrame(10),
				JSON.stringify({ _tag: "Exit" }),
			])
			const ticks = yield* objectSocketChanges(answering(socket, subscriptions), "session").pipe(
				Stream.runCollect,
			)
			expect(ticks).toHaveLength(2)
			expect(subscriptions).toEqual([expect.objectContaining({ mode: "watch", cursor: 0 })])
		}),
	)

	it.effect("ends the stream when a reader falls a whole buffer behind", () =>
		Effect.gen(function* () {
			const frames = Array.from({ length: 20 }, () => stateFrame(100 * 1024))
			const socket = pushingSocket(frames)
			const ticks = yield* objectSocketChanges(answering(socket), "session").pipe(Stream.runCollect)
			// Every frame up to the one that crossed the limit is delivered; the stream then ends.
			const delivered = Math.floor(SOCKET_BUFFER_BYTES / (frames[0]?.length ?? 1)) + 1
			expect(ticks).toHaveLength(delivered)
			expect(delivered).toBeLessThan(frames.length)
			// Effect closes it as over the limit, before the stream's own release closes it again.
			expect(socket.closes[0]).toBe(1008)
		}),
	)

	it.live("stops waiting for the socket upgrade when the reader goes away", () =>
		Effect.gen(function* () {
			const fiber = yield* objectSocketChanges(() => Effect.never, "session").pipe(
				Stream.runDrain,
				// Detached, so a fiber that ignores interrupts fails this test instead of hanging it.
				Effect.forkDetach,
			)
			yield* Effect.sleep(Duration.millis(20))
			// Interrupting waits for the fiber, so the wait that can time out is a separate one.
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
