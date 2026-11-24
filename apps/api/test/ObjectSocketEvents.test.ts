import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Schema from "effect/Schema"
import type * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import { SOCKET_BUFFER_BYTES, objectSocketEvents } from "../src/Http/ObjectSocketEvents.ts"

const Entry = Schema.Struct({ seq: Schema.Finite, text: Schema.String })

type Listener = (event: Socket.WebSocketEvent) => void

/** An accepted Durable Object socket that sends `frames` the moment the reader listens. */
const pushingSocket = (frames: ReadonlyArray<string>) => {
	const listeners = new Map<string, Array<Listener>>()
	const socket = {
		readyState: 1,
		closes: [] as Array<number | undefined>,
		accept: () => {},
		addEventListener: (type: string, listener: Listener) => {
			listeners.set(type, [...(listeners.get(type) ?? []), listener])
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

const answering = (socket: ReturnType<typeof pushingSocket>) => () =>
	Effect.succeed(HttpServerResponse.raw({ webSocket: socket }, { status: 101 }))

const chunk = (seq: number, bytes: number) =>
	JSON.stringify({ _tag: "Chunk", values: [{ seq, text: "x".repeat(bytes) }] })

describe("objectSocketEvents", () => {
	it.effect(
		"ends the stream when a reader falls a whole buffer behind, after what it received",
		() =>
			Effect.gen(function* () {
				const frameBytes = 100 * 1024
				const frames = Array.from({ length: 20 }, (_, seq) => chunk(seq + 1, frameBytes))
				const socket = pushingSocket(frames)
				const received = yield* objectSocketEvents(answering(socket), Entry, "session", 0).pipe(
					Stream.runCollect,
				)
				// Every frame up to the one that crossed the limit is delivered; the rest stay in the log.
				const delivered = Math.floor(SOCKET_BUFFER_BYTES / (frames[0]?.length ?? 1)) + 1
				expect(received.map((entry) => entry.seq)).toEqual(
					Array.from({ length: delivered }, (_, i) => i + 1),
				)
				expect(delivered).toBeLessThan(frames.length)
				// Effect closes it as over the limit, before the stream's own release closes it again.
				expect(socket.closes[0]).toBe(1008)
			}),
	)

	it.live("stops waiting for the socket upgrade when the reader goes away", () =>
		Effect.gen(function* () {
			const fiber = yield* objectSocketEvents(() => Effect.never, Entry, "session", 0).pipe(
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
