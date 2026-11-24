import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { CatalogConfig } from "./ApiCatalogStore.ts"

export class ApiCatalogCallFailed extends Schema.TaggedError<
	ApiCatalogCallFailed,
	{ readonly brand: unique symbol }
>()("ApiCatalogCallFailed", { cause: Schema.Unknown }) {}

/** How the API reaches an API server's catalog object, by catalog id. */
export interface ApiCatalogExecutorService {
	readonly store: (
		catalogId: string,
		document: string,
		config: CatalogConfig,
	) => Effect.Effect<boolean, ApiCatalogCallFailed>
	readonly keep: (catalogId: string) => Effect.Effect<void, ApiCatalogCallFailed>
}

export class ApiCatalogExecutor extends Context.Service<
	ApiCatalogExecutor,
	ApiCatalogExecutorService
>()("@checkfu/api/ApiCatalogExecutor") {}

export const makeApiCatalogExecutorLayer = (service: ApiCatalogExecutorService) =>
	Layer.succeed(ApiCatalogExecutor, service)
