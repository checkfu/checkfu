import { compile } from "@earendil-works/pi-schema"
import { formats } from "@earendil-works/pi-schema/formats"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"

export const schemaFault = (schema: Schema.JsonObject): string | null =>
	Result.match(
		Result.try(() => compile(schema, { formats })),
		{
			onSuccess: () => null,
			onFailure: (cause) => (cause instanceof Error ? cause.message : String(cause)),
		},
	)
