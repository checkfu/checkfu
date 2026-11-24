import type { ViewStore } from "@alchemy.run/domain/Platform"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"

export const ViewEventsOverObjectSockets = Context.Reference<boolean>(
	"@checkfu/api/ViewEventsOverObjectSockets",
	{ defaultValue: () => false },
)

type Connect = NonNullable<ViewStore["connect"]>

type AcceptedSocket = Socket.WebSocketLike & { accept(): void }

const isAcceptedSocket = (u: unknown): u is AcceptedSocket =>
	Predicate.hasProperty(u, "accept") && Predicate.hasProperty(u, "addEventListener")

const accepted = (connect: Connect, key: string) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const response = yield* connect(key, {
				requestId: 0,
				// Watching from version 0 sends the current state at once, then one per commit.
				mode: "watch",
				context: {},
				cursor: 0,
			}).pipe(
				Effect.provideService(
					HttpServerRequest.HttpServerRequest,
					HttpServerRequest.fromWeb(
						new Request("https://view.invalid/events", { headers: { upgrade: "websocket" } }),
					),
				),
				Effect.orDie,
			)
			const socket =
				response.body._tag === "Raw" && Predicate.hasProperty(response.body.body, "webSocket")
					? response.body.body.webSocket
					: undefined
			if (!isAcceptedSocket(socket)) {
				return yield* Effect.die(new Error(`Live read upgrade answered ${response.status}.`))
			}
			socket.accept()
			return socket
		}),
		(socket) => Effect.sync(() => socket.close(1000, "")),
		// The upgrade can be retried for a while during a deploy; a client that left stops it.
		{ interruptible: true },
	)

// Cloudflare's WebSocket cannot pause, so frames a slow client has not read wait in the Worker.
// Past this many bytes the stream ends and the client resumes from the last event it received.
export const SOCKET_BUFFER_BYTES = 1024 * 1024

/**
 * A tick each time the view key changes, from the Durable Object that owns it over a
 * hibernatable WebSocket. The socket watches the key's state rather than replaying its entries,
 * so each frame holds one state however long the upgrade took; the first comes as soon as it
 * opens. The caller reads what changed in bounded pages. Ends when the object closes the socket
 * or the caller falls `SOCKET_BUFFER_BYTES` behind.
 */
export const objectSocketChanges = (connect: Connect, key: string): Stream.Stream<void> => {
	const decodeFrame = Schema.decodeUnknownEffect(
		Schema.fromJsonString(
			Schema.Union([
				Schema.TaggedStruct("Chunk", { values: Schema.NonEmptyArray(Schema.Json) }),
				Schema.TaggedStruct("Exit", {}),
			]),
		),
	)
	const text = new TextDecoder()
	return Stream.unwrap(
		Effect.map(
			Socket.fromWebSocket(accepted(connect, key), {
				disableReconnects: true,
				highWaterMark: SOCKET_BUFFER_BYTES,
			}),
			Socket.toStream,
		),
	).pipe(
		// A closed or overflowed socket ends the stream.
		Stream.catchIf(
			(error) =>
				error.reason._tag === "SocketCloseError" || error.reason._tag === "SocketReadError",
			() => Stream.empty,
		),
		Stream.mapEffect((bytes) => decodeFrame(text.decode(bytes))),
		Stream.takeWhile((frame) => frame._tag === "Chunk"),
		Stream.as(undefined),
		Stream.orDie,
	)
}
