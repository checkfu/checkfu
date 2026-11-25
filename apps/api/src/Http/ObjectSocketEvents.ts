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
		{ interruptible: true },
	)

export const SOCKET_BUFFER_BYTES = 1024 * 1024

const Watched = Schema.Struct({
	cursor: Schema.Finite,
	state: Schema.NullOr(Schema.Struct({ archived_at: Schema.NullOr(Schema.String) })),
})

export interface ViewHead {
	readonly seq: number
	readonly archived: boolean
}

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
