import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Base64Url from "effect/encoding/Base64Url"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { configuredApiCustomProviders, suggestedCatalogModelIds } from "../Pi/PiCatalog.ts"
import { CheckfuApi } from "./Api.ts"
import { handled, reject } from "./HttpHelpers.ts"
import { listPage } from "./Listing.ts"

const utf8 = new TextEncoder()

const decodeCursor = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Struct({ search: Schema.String, after: Schema.String })),
)

export const ModelsLive = HttpApiBuilder.group(CheckfuApi, "models", (handlers) =>
	Effect.gen(function* () {
		const ids = suggestedCatalogModelIds(yield* configuredApiCustomProviders)
		return handlers.handle("list", ({ query }) =>
			Effect.gen(function* () {
				const search = query.search?.trim().toLowerCase() ?? ""
				const fingerprint = Base64Url.encode(
					new Uint8Array(
						yield* Effect.promise(() => crypto.subtle.digest("SHA-256", utf8.encode(search))),
					),
				)
				const limit = query.limit ?? 50
				let after = ""
				if (query.page !== undefined) {
					const text = Base64Url.decodeString(query.page)
					const cursor = Result.isSuccess(text) ? decodeCursor(text.success) : undefined
					if (
						cursor === undefined ||
						Result.isFailure(cursor) ||
						cursor.success.search !== fingerprint
					) {
						return yield* reject(400, "Invalid page token for the model search.")
					}
					after = cursor.success.after
				}
				const matches = ids
					.filter((id) => id > after && id.toLowerCase().includes(search))
					.slice(0, limit + 1)
				const data = matches.slice(0, limit).map((id) => ({ type: "model" as const, id }))
				const last = data.at(-1)
				return listPage(
					data,
					matches.length > limit && last !== undefined
						? Base64Url.encode(JSON.stringify({ search: fingerprint, after: last.id }))
						: null,
				)
			}).pipe(handled),
		)
	}),
)
