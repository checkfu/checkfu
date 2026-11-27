import { CheckfuApi } from "@checkfu/sdk/Api"
import type * as HttpApi from "effect/http-api/HttpApi"
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"

const includeAnnotationKey = (key: string): boolean => key === "x-forge-sensitive"

export const buildOpenApiJson = <Id extends string, Groups extends HttpApiGroup.Constraint>(
	api?: HttpApi.HttpApi<Id, Groups>,
): string =>
	`${JSON.stringify(api === undefined ? OpenApi.fromApi(CheckfuApi, { includeAnnotationKey }) : OpenApi.fromApi(api, { includeAnnotationKey }), null, 2)}\n`

export const exportDeterministicOpenApiJson = <
	Id extends string,
	Groups extends HttpApiGroup.Constraint,
>(
	api?: HttpApi.HttpApi<Id, Groups>,
): string => {
	const first = buildOpenApiJson(api)
	const second = buildOpenApiJson(api)
	if (first !== second) {
		throw new Error(
			"OpenApi.fromApi is non-deterministic: two consecutive exports produced different bytes.",
		)
	}
	return first
}
