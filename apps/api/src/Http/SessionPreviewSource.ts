import type { PreviewPacket } from "../Pi/PiEventPreviews.ts"
import * as Context from "effect/Context"
import * as Stream from "effect/Stream"

export const SessionPreviewSource = Context.Reference<(id: string) => Stream.Stream<PreviewPacket>>(
	"@checkfu/api/SessionPreviewSource",
	{ defaultValue: () => () => Stream.empty },
)
