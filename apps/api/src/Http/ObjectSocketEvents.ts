import type { ViewStore } from "@alchemy.run/domain/Platform"
import * as Arr from "effect/Array"
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

// What a watch frame says about the key: the seq of its newest entry, and whether its state
// is archived.
const Watched = Schema.Struct({
	cursor: Schema.Finite,
	state: Schema.NullOr(Schema.Struct({ archived_at: Schema.NullOr(Schema.String) })),
})

export interface ViewHead {
	readonly seq: number
	readonly archived: boolean
}

/**
 * The view key's head each time it changes, from the Durable Object that owns it over a
 * hibernatable WebSocket. The socket watches the key's state rather than replaying its entries,
 * so each frame holds one state however long the upgrade took; the first comes as soon as it
 * opens. The caller reads what changed in bounded pages. Ends when the object closes the socket
 * or the caller falls `SOCKET_BUFFER_BYTES` behind.
 */
export const objectSocketChanges = (connect: Connect, key: string): Stream.Stream<ViewHead> => {
	const decodeFrame = Schema.decodeUnknownEffect(
		Schema.fromJsonString(
			Schema.Union([
				Schema.TaggedStruct("Chunk", { values: Schema.NonEmptyArray(Watched) }),
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
		Stream.takeWhile(
			(frame): frame is Extract<typeof frame, { _tag: "Chunk" }> => frame._tag === "Chunk",
		),
		Stream.map((frame): ViewHead => {
			const watched = Arr.lastNonEmpty(frame.values)
			return {
				seq: watched.cursor,
				archived: watched.state !== null && watched.state.archived_at !== null,
			}
		}),
		Stream.orDie,
	)
}
