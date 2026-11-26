import type { Forge } from "@cloudflare/forge"
import { file, module } from "@cloudflare/forge/ts"
import { buildSurfaceCatalog, cleanGeneratedHeader } from "./SurfaceCatalog.ts"
import type {
	GeneratedFile,
	SurfaceGroupNode,
	SurfaceOperation,
	SurfaceParam,
} from "./SurfaceCatalog.ts"

const RESERVED_ARG_NAMES = new Set(["params", "body", "query", "options", "pathParams", "key"])

const safeParamArgName = (param: SurfaceParam): string =>
	RESERVED_ARG_NAMES.has(param.camelName) ? `${param.camelName}Param` : param.camelName

const formatJsDocComment = (text: string): string =>
	text
		.replaceAll("*/", String.raw`*\/`)
		.replaceAll(/\s+/g, " ")
		.trim()

const collectGroupsBottomUp = (node: SurfaceGroupNode, out: Array<SurfaceGroupNode>): void => {
	for (const child of node.children) {
		collectGroupsBottomUp(child, out)
	}
	if (node.path.length > 0) {
		out.push(node)
	}
}

const effectClassName = (node: SurfaceGroupNode): string => `Effect${node.pascalPath}Resource`
const promiseClassName = (node: SurfaceGroupNode): string => `${node.pascalPath}Resource`

const generateOperationBindingsFile = (
	operations: ReadonlyArray<SurfaceOperation>,
): GeneratedFile => {
	const out = file("OperationBindings.ts")

	out('export type SdkOperationKind = "unary" | "paginated" | "sse"')
	out('export type SdkRetrySafety = "idempotent" | "pre-commit-only" | "idempotency-key-gated"')
	out()
	out("export interface SdkOperationBinding {")
	out.indent(() => {
		out("readonly operationId: string")
		out("readonly apiGroup: string")
		out("readonly apiEndpoint: string")
		out("readonly member: string")
		out("readonly cliCommand: string")
		out("readonly httpMethod: string")
		out("readonly path: string")
		out("readonly pathParams: ReadonlyArray<string>")
		out("readonly queryParams: ReadonlyArray<string>")
		out("readonly requiredQueryParams: ReadonlyArray<string>")
		out("readonly kind: SdkOperationKind")
		out("readonly retrySafety: SdkRetrySafety")
		out("readonly supportsIdempotencyKey: boolean")
		out("readonly requiresIdempotencyKey: boolean")
		out("readonly hasBody: boolean")
		out("readonly bodyRequired: boolean")
		out("readonly supportsPending: boolean")
	})
	out("}")
	out()
	out("export const SDK_OPERATION_BINDINGS = [")
	out.indent(() => {
		for (const op of operations) {
			out("{")
			out.indent(() => {
				out("operationId: ", JSON.stringify(op.operationId), ",")
				out("apiGroup: ", JSON.stringify(op.apiGroup), ",")
				out("apiEndpoint: ", JSON.stringify(op.apiEndpoint), ",")
				out("member: ", JSON.stringify(op.operationId), ",")
				out("cliCommand: ", JSON.stringify(op.cliCommand), ",")
				out("httpMethod: ", JSON.stringify(op.httpMethod), ",")
				out("path: ", JSON.stringify(op.path), ",")
				out("pathParams: ", JSON.stringify(op.pathParams.map((param) => param.wireName)), ",")
				out("queryParams: ", JSON.stringify(op.queryParams.map((param) => param.wireName)), ",")
				out(
					"requiredQueryParams: ",
					JSON.stringify(
						op.queryParams.filter((param) => param.required).map((param) => param.wireName),
					),
					",",
				)
				out("kind: ", JSON.stringify(op.kind), ",")
				out("retrySafety: ", JSON.stringify(op.retrySafety), ",")
				out("supportsIdempotencyKey: ", op.supportsIdempotencyKey, ",")
				out("requiresIdempotencyKey: ", op.requiresIdempotencyKey, ",")
				out("hasBody: ", op.hasBody, ",")
				out("bodyRequired: ", op.bodyRequired, ",")
				out("supportsPending: ", op.supportsPending, ",")
			})
			out("},")
		}
	})
	out("] as const satisfies ReadonlyArray<SdkOperationBinding>")

	return {
		path: "OperationBindings.ts",
		content: cleanGeneratedHeader(out.content),
	}
}

const generateResourcesFile = (
	root: SurfaceGroupNode,
	operations: ReadonlyArray<SurfaceOperation>,
): GeneratedFile => {
	const effectMod = module("effect/Effect")
	const streamMod = module("effect/Stream")
	const errorsMod = module("../Errors.ts")
	const runtimeMod = module("../Runtime.ts")
	const promiseRuntimeMod = module("../PromiseRuntime.ts")

	const EffectType = effectMod.ident("Effect").ty()
	const EffectFlatMap = effectMod.ident("flatMap").as("EffectFlatMap")
	const StreamType = streamMod.ident("Stream").ty()

	const CheckfuSdkError = errorsMod.ident("CheckfuSdkError").ty()

	const AnyRequestOptions = runtimeMod.ident("AnyRequestOptions").ty()
	const EffectSdkRuntime = runtimeMod.ident("EffectSdkRuntime").ty()
	const EndpointBody = runtimeMod.ident("EndpointBody").ty()
	const EndpointJsonSuccess = runtimeMod.ident("EndpointJsonSuccess").ty()
	const EndpointJsonBody = runtimeMod.ident("EndpointJsonBody").ty()
	const EndpointParams = runtimeMod.ident("EndpointParams").ty()
	const PathParam = runtimeMod.ident("PathParam").ty()
	const EndpointQuery = runtimeMod.ident("EndpointQuery").ty()
	const EndpointSseEvent = runtimeMod.ident("EndpointSseEvent").ty()
	const EndpointSuccess = runtimeMod.ident("EndpointSuccess").ty()
	const IsoDateTimes = runtimeMod.ident("IsoDateTimes").ty()
	const ItemOf = runtimeMod.ident("ItemOf").ty()
	const OperationShape = runtimeMod.ident("OperationShape").ty()
	const RelaxOptionalProps = runtimeMod.ident("RelaxOptionalProps").ty()
	const RequestOptions = runtimeMod.ident("RequestOptions").ty()
	const SessionEventsStreamOptions = runtimeMod.ident("SessionEventsStreamOptions").ty()
	const WithResponse = runtimeMod.ident("WithResponse").ty()
	const WithResponseRequestOptions = runtimeMod.ident("WithResponseRequestOptions").ty()

	const decodeEndpointParams = runtimeMod.ident("decodeEndpointParams")
	const executeEndpointSseEffect = runtimeMod.ident("executeEndpointSseEffect")
	const executePaginatedPagesEffect = runtimeMod.ident("executePaginatedPagesEffect")
	const executePaginatedStreamEffect = runtimeMod.ident("executePaginatedStreamEffect")
	const executeWithRetries = runtimeMod.ident("executeWithRetries")
	const pendingUpdateReadiness = runtimeMod.ident("pendingUpdateReadiness")
	const resolveCallIdempotencyKey = runtimeMod.ident("resolveCallIdempotencyKey")
	const resolveRequiredIdempotencyKey = runtimeMod.ident("resolveRequiredIdempotencyKey")
	const unwrapResponse = runtimeMod.ident("unwrapResponse")
	const withPendingReadiness = runtimeMod.ident("withPendingReadiness")
	const withResolvedIdempotencyKey = runtimeMod.ident("withResolvedIdempotencyKey")

	const APIPromise = promiseRuntimeMod.ident("APIPromise").ty()
	const CursorPage = promiseRuntimeMod.ident("CursorPage").ty()
	const EventStreamPromise = promiseRuntimeMod.ident("EventStreamPromise").ty()
	const PagePromise = promiseRuntimeMod.ident("PagePromise").ty()
	const PromiseRequestOptions = promiseRuntimeMod.ident("PromiseRequestOptions").ty()
	const PromiseSdkRuntime = promiseRuntimeMod.ident("PromiseSdkRuntime").ty()
	const PromiseStreamOptions = promiseRuntimeMod.ident("PromiseStreamOptions").ty()

	const executePaginatedPromise = promiseRuntimeMod.ident("executePaginatedPromise")
	const executeSseStreamPromise = promiseRuntimeMod.ident("executeSseStreamPromise")
	const executeUnaryPromise = promiseRuntimeMod.ident("executeUnaryPromise")

	const out = file("Resources.ts")

	out("export interface CheckfuOperations {")
	out.indent(() => {
		for (const op of operations) {
			const g = JSON.stringify(op.apiGroup)
			const e = JSON.stringify(op.apiEndpoint)
			out("readonly ", JSON.stringify(op.operationId), ": ", OperationShape, "<")
			out.indent(() => {
				out(EndpointParams, "<", g, ", ", e, ">,")
				if (op.kind === "sse") {
					if (op.sse?.cursorParam !== undefined) {
						out(
							"{ readonly ",
							JSON.stringify(op.sse.cursorParam),
							"?: ",
							op.sse.cursorType,
							" | undefined },",
						)
					} else if (op.queryParams.length > 0) {
						out(RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
					} else {
						out("never,")
					}
					out("never,")
					out(EndpointSseEvent, "<", g, ", ", e, ">")
				} else {
					if (op.queryParams.length > 0) {
						out(RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
					} else {
						out(EndpointQuery, "<", g, ", ", e, ">,")
					}
					out(EndpointBody, "<", g, ", ", e, ">,")
					out(EndpointSuccess, "<", g, ", ", e, ">,")
					out(EndpointJsonSuccess, "<", g, ", ", e, ">,")
					out(EndpointJsonBody, "<", g, ", ", e, ">")
				}
			})
			out(">")
		}
	})
	out("}")
	out()
	out("export type CheckfuOperationId = keyof CheckfuOperations")
	out("export type Op<K extends CheckfuOperationId> = CheckfuOperations[K]")
	out()

	const emitEffectOperation = (op: SurfaceOperation): void => {
		const g = JSON.stringify(op.apiGroup)
		const e = JSON.stringify(op.apiEndpoint)
		const docText = formatJsDocComment(op.description || op.summary || op.operationId)
		const pathArgs = op.pathParams.map((p) => ({
			argName: safeParamArgName(p),
			wireName: p.wireName,
		}))

		if (op.kind === "sse") {
			out("/** ", docText, " */")
			out(op.methodName, "(")
			out.indent(() => {
				for (const pa of pathArgs) {
					out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
				}
				if (op.queryParams.length > 0 || op.sse?.cursorParam !== undefined) {
					if (op.sse?.cursorParam !== undefined) {
						out(
							"params?: { readonly ",
							JSON.stringify(op.sse.cursorParam),
							"?: ",
							op.sse.cursorType,
							" | undefined },",
						)
					} else {
						out("params?: ", RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
					}
				}
				out("options?: ", SessionEventsStreamOptions, ",")
			})
			out("): ", StreamType, "<", EndpointSseEvent, "<", g, ", ", e, ">, ", CheckfuSdkError, "> {")
			out.indent(() => {
				out("return ", executeEndpointSseEffect, "(")
				out.indent(() => {
					out("this.#runtime,")
					out(g, ",")
					out(e, ",")
					if (pathArgs.length === 0) {
						out("{},")
					} else {
						out("{ ", pathArgs.map(pathArgEntry).join(", "), " },")
					}
					if (op.queryParams.length > 0 || op.sse?.cursorParam !== undefined) {
						out("params,")
					} else {
						out("undefined,")
					}
					out("options,")
				})
				out(")")
			})
			out("}")
			out()
			return
		}

		const hasQueryOnly = !op.hasBody && op.queryParams.length > 0
		const hasBodyOnly = op.hasBody && op.queryParams.length === 0
		const hasBodyAndQuery = op.hasBody && op.queryParams.length > 0
		const acceptsOptionsWithQuery =
			hasQueryOnly && !op.hasRequiredQuery && !op.requiresIdempotencyKey

		const emitSignatureArgs = (
			mode: "withResponse" | "default" | "impl",
			inlineOptions = false,
		): void => {
			for (const pa of pathArgs) {
				out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
			}
			if (hasBodyOnly) {
				const opt = !op.bodyRequired && mode !== "withResponse" ? "?" : ""
				const undef = !op.bodyRequired && mode === "withResponse" ? " | undefined" : ""
				out("params", opt, ": ", EndpointBody, "<", g, ", ", e, ">", undef, ",")
			} else if (hasQueryOnly) {
				const opt = !op.hasRequiredQuery && mode !== "withResponse" ? "?" : ""
				const undef =
					!op.hasRequiredQuery && mode === "withResponse" && !inlineOptions ? " | undefined" : ""
				out(
					"params",
					opt,
					": ",
					RelaxOptionalProps,
					"<",
					EndpointQuery,
					"<",
					g,
					", ",
					e,
					">>",
					...(acceptsOptionsWithQuery
						? [
								" & ",
								inlineOptions
									? WithResponseRequestOptions
									: mode === "default"
										? RequestOptions
										: AnyRequestOptions,
							]
						: []),
					undef,
					",",
				)
			} else if (hasBodyAndQuery) {
				const bodyOpt = !op.bodyRequired && mode !== "withResponse" ? "?" : ""
				const bodyUndef = !op.bodyRequired && mode === "withResponse" ? " | undefined" : ""
				out("body", bodyOpt, ": ", EndpointBody, "<", g, ", ", e, ">", bodyUndef, ",")
				const queryOpt = !op.hasRequiredQuery && mode !== "withResponse" ? "?" : ""
				const queryUndef = !op.hasRequiredQuery && mode === "withResponse" ? " | undefined" : ""
				out(
					"query",
					queryOpt,
					": ",
					RelaxOptionalProps,
					"<",
					EndpointQuery,
					"<",
					g,
					", ",
					e,
					">>",
					queryUndef,
					",",
				)
			}
			if (inlineOptions) {
				return
			}
			const keyed = op.requiresIdempotencyKey ? " & { readonly idempotencyKey: string }" : ""
			if (mode === "withResponse") {
				out("options: ", WithResponseRequestOptions, keyed, ",")
			} else if (mode === "default") {
				out(op.requiresIdempotencyKey ? "options: " : "options?: ", RequestOptions, keyed, ",")
			} else {
				out(op.requiresIdempotencyKey ? "options: " : "options?: ", AnyRequestOptions, keyed, ",")
			}
		}

		out("/** ", docText, " */")
		const emitWithResponseSignature = (inlineOptions: boolean): void => {
			out(op.methodName, "(")
			out.indent(() => emitSignatureArgs("withResponse", inlineOptions))
			out(
				"): ",
				EffectType,
				"<",
				WithResponse,
				"<",
				EndpointSuccess,
				"<",
				g,
				", ",
				e,
				">>, ",
				CheckfuSdkError,
				">",
			)
		}
		emitWithResponseSignature(false)
		if (acceptsOptionsWithQuery) {
			emitWithResponseSignature(true)
		}
		out(op.methodName, "(")
		out.indent(() => emitSignatureArgs("default"))
		out("): ", EffectType, "<", EndpointSuccess, "<", g, ", ", e, ">, ", CheckfuSdkError, ">")
		out(op.methodName, "(")
		out.indent(() => emitSignatureArgs("impl"))
		out(
			"): ",
			EffectType,
			"<",
			EndpointSuccess,
			"<",
			g,
			", ",
			e,
			"> | ",
			WithResponse,
			"<",
			EndpointSuccess,
			"<",
			g,
			", ",
			e,
			">>, ",
			CheckfuSdkError,
			"> {",
		)
		out.indent(() => {
			if (acceptsOptionsWithQuery) {
				out("options ??= params")
			}
			const emitRawInvoke = (): void => {
				const safetyExpr =
					op.retrySafety === "idempotency-key-gated"
						? 'key !== undefined ? "idempotent" : "pre-commit-only"'
						: JSON.stringify(op.retrySafety)
				out(
					executeWithRetries,
					"(this.#runtime, ",
					JSON.stringify(`checkfu.${op.operationId}`),
					", ",
					safetyExpr,
					", ",
					op.supportsIdempotencyKey ? [withResolvedIdempotencyKey, "(options, key)"] : "options",
					", () =>",
				)
				out.indent(() => {
					out("this.#runtime.raw.", op.apiGroup, ".", op.apiEndpoint, "({")
					out.indent(() => {
						if (pathArgs.length > 0) {
							out("params: pathParams,")
						}
						if (op.queryParams.length > 0) {
							const qVar = hasBodyAndQuery ? "query" : "params"
							const singleQuery = op.queryParams[0]
							if (
								op.queryParams.length === 1 &&
								singleQuery !== undefined &&
								!singleQuery.required
							) {
								const key = JSON.stringify(singleQuery.wireName)
								const field = `${qVar}?.[${key}]`
								out("query: ", field, " === undefined ? {} : { ", key, ": ", field, " },")
							} else {
								out("query: {")
								out.indent(() => {
									for (const qp of op.queryParams) {
										const keyJson = JSON.stringify(qp.wireName)
										if (qp.required) {
											out(keyJson, ": ", qVar, "[", keyJson, "],")
											continue
										}
										out(
											"...(",
											qVar,
											"?.[",
											keyJson,
											"] === undefined ? {} : { ",
											keyJson,
											": ",
											qVar,
											"[",
											keyJson,
											"] }),",
										)
									}
								})
								out("},")
							}
						}
						if (op.requiresIdempotencyKey) {
							out('headers: { "idempotency-key": key },')
						} else if (op.supportsIdempotencyKey) {
							out('headers: key === undefined ? {} : { "idempotency-key": key },')
						}
						if (op.hasBody) {
							const bVar = hasBodyAndQuery ? "body" : "params"
							if (op.bodyRequired) {
								out("payload: ", bVar, ",")
							} else {
								out("...(", bVar, " === undefined ? {} : { payload: ", bVar, " }),")
							}
						}
						out('responseMode: "decoded-and-response",')
					})
					out("}),")
				})
				out(")")
			}

			const emitInvoke = (): void => {
				if (!op.supportsPending) {
					emitRawInvoke()
					return
				}
				const bVar = hasBodyAndQuery ? "body" : "params"
				out(withPendingReadiness, "(")
				out.indent(() => {
					emitRawInvoke()
					out(",")
					if (op.methodName === "create") {
						out('{ kind: "create" },')
					} else if (op.methodName === "archive") {
						out('{ kind: "archive" },')
					} else if (op.methodName === "update" && op.hasBody) {
						out(pendingUpdateReadiness, "(", bVar, ", ", JSON.stringify(op.operationId), "),")
					} else {
						out('{ kind: "requires-until", operation: ', JSON.stringify(op.operationId), " },")
					}
				})
				out(")")
			}

			const emitWithIdempotency = (): void => {
				if (!op.supportsIdempotencyKey) {
					emitInvoke()
					return
				}
				out(
					EffectFlatMap,
					"(",
					op.requiresIdempotencyKey ? resolveRequiredIdempotencyKey : resolveCallIdempotencyKey,
					op.requiresIdempotencyKey
						? "(this.#runtime, options), (key) =>"
						: "(this.#runtime, options, true), (key) =>",
				)
				out.indent(() => emitInvoke())
				out(")")
			}

			out("return ", unwrapResponse, "(")
			out.indent(() => {
				if (pathArgs.length > 0) {
					out(
						EffectFlatMap,
						"(",
						decodeEndpointParams,
						"(",
						g,
						", ",
						e,
						", { ",
						pathArgs.map(pathArgEntry).join(", "),
						" }), (pathParams) =>",
					)
					out.indent(() => emitWithIdempotency())
					out("),")
				} else {
					emitWithIdempotency()
					out(",")
				}
				out("options,")
			})
			out(")")
		})
		out("}")
		out()

		if (op.kind === "paginated" && op.pagination !== undefined) {
			const cursorParam = op.pagination.cursorParam
			const cursorKeyJson = JSON.stringify(cursorParam)
			const orderExpr = op.pagination.hasOrderParam ? 'params?.order ?? "asc"' : '"asc"'

			out("/** Auto-paginate pages for ", docText, " */")
			out(op.methodName, "Pages(")
			out.indent(() => {
				for (const pa of pathArgs) {
					out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
				}
				out("params?: ", RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
				out("options?: ", RequestOptions, ",")
			})
			out("): ", StreamType, "<", EndpointSuccess, "<", g, ", ", e, ">, ", CheckfuSdkError, "> {")
			out.indent(() => {
				out("return ", executePaginatedPagesEffect, "(")
				out.indent(() => {
					out("(cursor) =>")
					out.indent(() => {
						out("this.", op.methodName, "(")
						out.indent(() => {
							for (const pa of pathArgs) {
								out(pa.argName, ",")
							}
							out("{")
							out.indent(() => {
								out("...params,")
								out("...(cursor === undefined ? {} : { ", cursorKeyJson, ": cursor }),")
							})
							out("},")
							out("options,")
						})
						out("),")
					})
					out("params?.[", cursorKeyJson, "],")
					out(orderExpr, ",")
				})
				out(")")
			})
			out("}")
			out()

			out("/** Auto-paginate items for ", docText, " */")
			out(op.methodName, "Stream(")
			out.indent(() => {
				for (const pa of pathArgs) {
					out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
				}
				out("params?: ", RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
				out("options?: ", RequestOptions, ",")
			})
			out(
				"): ",
				StreamType,
				"<",
				ItemOf,
				"<",
				EndpointSuccess,
				"<",
				g,
				", ",
				e,
				">>, ",
				CheckfuSdkError,
				"> {",
			)
			out.indent(() => {
				out("return ", executePaginatedStreamEffect, "(")
				out.indent(() => {
					out("(cursor) =>")
					out.indent(() => {
						out("this.", op.methodName, "(")
						out.indent(() => {
							for (const pa of pathArgs) {
								out(pa.argName, ",")
							}
							out("{")
							out.indent(() => {
								out("...params,")
								out("...(cursor === undefined ? {} : { ", cursorKeyJson, ": cursor }),")
							})
							out("},")
							out("options,")
						})
						out("),")
					})
					out("params?.[", cursorKeyJson, "],")
					out(orderExpr, ",")
				})
				out(")")
			})
			out("}")
			out()
		}
	}

	const emitPromiseOperation = (op: SurfaceOperation, effectClsName: string): void => {
		const g = JSON.stringify(op.apiGroup)
		const e = JSON.stringify(op.apiEndpoint)
		const docText = formatJsDocComment(op.description || op.summary || op.operationId)
		const pathArgs = op.pathParams.map((p) => ({
			argName: safeParamArgName(p),
			wireName: p.wireName,
		}))

		if (op.kind === "sse") {
			out("/** ", docText, " */")
			out(op.methodName, "(")
			out.indent(() => {
				for (const pa of pathArgs) {
					out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
				}
				if (op.queryParams.length > 0 || op.sse?.cursorParam !== undefined) {
					if (op.sse?.cursorParam !== undefined) {
						out(
							"params?: { readonly ",
							JSON.stringify(op.sse.cursorParam),
							"?: ",
							op.sse.cursorType,
							" | undefined },",
						)
					} else {
						out("params?: ", RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
					}
				}
				out("options?: ", PromiseStreamOptions, ",")
			})
			out(
				"): ",
				EventStreamPromise,
				"<",
				IsoDateTimes,
				"<",
				EndpointSseEvent,
				"<",
				g,
				", ",
				e,
				">>> {",
			)
			out.indent(() => {
				out(
					"return ",
					executeSseStreamPromise,
					"(this.#runtime, options, (effectRuntime, effectStreamOpts) =>",
				)
				out.indent(() => {
					out("new ", effectClsName, "(effectRuntime).", op.methodName, "(")
					out.indent(() => {
						for (const pa of pathArgs) {
							out(pa.argName, ",")
						}
						if (op.queryParams.length > 0 || op.sse?.cursorParam !== undefined) {
							out("params,")
						}
						out("effectStreamOpts,")
					})
					out("),")
				})
				out(")")
			})
			out("}")
			out()
			return
		}

		if (op.kind === "paginated" && op.pagination !== undefined) {
			const cursorParam = op.pagination.cursorParam
			const cursorKeyJson = JSON.stringify(cursorParam)
			const cursorType = op.pagination.cursorType
			const orderExpr = op.pagination.hasOrderParam ? 'params?.order ?? "asc"' : '"asc"'

			out("/** ", docText, " */")
			out(op.methodName, "(")
			out.indent(() => {
				for (const pa of pathArgs) {
					out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
				}
				out("params?: ", RelaxOptionalProps, "<", EndpointQuery, "<", g, ", ", e, ">>,")
				out("options?: ", PromiseRequestOptions, ",")
			})
			out(
				"): ",
				PagePromise,
				"<",
				CursorPage,
				"<",
				ItemOf,
				"<",
				EndpointJsonSuccess,
				"<",
				g,
				", ",
				e,
				">>, ",
				cursorType,
				">, ",
				ItemOf,
				"<",
				EndpointJsonSuccess,
				"<",
				g,
				", ",
				e,
				">>> {",
			)
			out.indent(() => {
				out("return ", executePaginatedPromise, "(")
				out.indent(() => {
					out("this.#runtime,")
					out("params?.[", cursorKeyJson, "],")
					out(orderExpr, ",")
					out("options,")
					out("(effectRuntime, cursor, effectOpts) =>")
					out.indent(() => {
						out("new ", effectClsName, "(effectRuntime).", op.methodName, "(")
						out.indent(() => {
							for (const pa of pathArgs) {
								out(pa.argName, ",")
							}
							out("{")
							out.indent(() => {
								out("...params,")
								out("...(cursor === undefined ? {} : { ", cursorKeyJson, ": cursor }),")
							})
							out("},")
							out("{ ...effectOpts, withResponse: true },")
						})
						out("),")
					})
				})
				out(")")
			})
			out("}")
			out()
			return
		}

		const hasQueryOnly = !op.hasBody && op.queryParams.length > 0
		const hasBodyOnly = op.hasBody && op.queryParams.length === 0
		const hasBodyAndQuery = op.hasBody && op.queryParams.length > 0
		const acceptsOptionsWithQuery =
			hasQueryOnly && !op.hasRequiredQuery && !op.requiresIdempotencyKey

		out("/** ", docText, " */")
		out(op.methodName, "(")
		out.indent(() => {
			for (const pa of pathArgs) {
				out(pa.argName, ": ", PathParam, "<", g, ", ", e, ", ", JSON.stringify(pa.wireName), ">,")
			}
			if (hasBodyOnly) {
				out("params", op.bodyRequired ? "" : "?", ": ", EndpointBody, "<", g, ", ", e, ">,")
			} else if (hasQueryOnly) {
				out(
					"params",
					op.hasRequiredQuery ? "" : "?",
					": ",
					RelaxOptionalProps,
					"<",
					EndpointQuery,
					"<",
					g,
					", ",
					e,
					">>",
					...(acceptsOptionsWithQuery ? [" & ", PromiseRequestOptions] : []),
					",",
				)
			} else if (hasBodyAndQuery) {
				out("body", op.bodyRequired ? "" : "?", ": ", EndpointBody, "<", g, ", ", e, ">,")
				out(
					"query",
					op.hasRequiredQuery ? "" : "?",
					": ",
					RelaxOptionalProps,
					"<",
					EndpointQuery,
					"<",
					g,
					", ",
					e,
					">>,",
				)
			}
			if (op.requiresIdempotencyKey) {
				out("options: ", PromiseRequestOptions, " & { readonly idempotencyKey: string },")
			} else {
				out("options?: ", PromiseRequestOptions, ",")
			}
		})
		out("): ", APIPromise, "<", EndpointJsonSuccess, "<", g, ", ", e, ">> {")
		out.indent(() => {
			out(
				"return ",
				executeUnaryPromise,
				"(this.#runtime, ",
				acceptsOptionsWithQuery ? "options ?? params" : "options",
				", (effectRuntime, effectOpts) =>",
			)
			out.indent(() => {
				out("new ", effectClsName, "(effectRuntime).", op.methodName, "(")
				out.indent(() => {
					for (const pa of pathArgs) {
						out(pa.argName, ",")
					}
					if (hasBodyOnly || hasQueryOnly) {
						out("params,")
					} else if (hasBodyAndQuery) {
						out("body,")
						out("query,")
					}
					out(
						op.requiresIdempotencyKey
							? "{ ...effectOpts, idempotencyKey: options?.idempotencyKey, withResponse: true },"
							: "{ ...effectOpts, withResponse: true },",
					)
				})
				out("),")
			})
			out(")")
		})
		out("}")
		out()
	}

	const groupNodes: Array<SurfaceGroupNode> = []
	collectGroupsBottomUp(root, groupNodes)

	for (const node of groupNodes) {
		const clsName = effectClassName(node)
		out("export class ", clsName, " {")
		out.indent(() => {
			if (node.operations.length > 0) {
				out("readonly #runtime: ", EffectSdkRuntime)
			}
			for (const child of node.children) {
				out("readonly ", child.name, ": ", effectClassName(child))
			}
			out()
			out("constructor(runtime: ", EffectSdkRuntime, ") {")
			out.indent(() => {
				if (node.operations.length > 0) {
					out("this.#runtime = runtime")
				}
				for (const child of node.children) {
					out("this.", child.name, " = new ", effectClassName(child), "(runtime)")
				}
			})
			out("}")
			out()
			for (const op of node.operations) {
				emitEffectOperation(op)
			}
		})
		out("}")
		out()
	}

	out("export class EffectResources {")
	out.indent(() => {
		if (root.operations.length > 0) {
			out("readonly #runtime: ", EffectSdkRuntime)
		}
		for (const child of root.children) {
			out("readonly ", child.name, ": ", effectClassName(child))
		}
		out()
		out("constructor(runtime: ", EffectSdkRuntime, ") {")
		out.indent(() => {
			if (root.operations.length > 0) {
				out("this.#runtime = runtime")
			}
			for (const child of root.children) {
				out("this.", child.name, " = new ", effectClassName(child), "(runtime)")
			}
		})
		out("}")
		if (root.operations.length > 0) {
			out()
			for (const op of root.operations) {
				emitEffectOperation(op)
			}
		}
	})
	out("}")
	out()

	for (const node of groupNodes) {
		const clsName = promiseClassName(node)
		const effectClsName = effectClassName(node)
		out("export class ", clsName, " {")
		out.indent(() => {
			if (node.operations.length > 0) {
				out("readonly #runtime: ", PromiseSdkRuntime)
			}
			for (const child of node.children) {
				out("readonly ", child.name, ": ", promiseClassName(child))
			}
			out()
			out("constructor(runtime: ", PromiseSdkRuntime, ") {")
			out.indent(() => {
				if (node.operations.length > 0) {
					out("this.#runtime = runtime")
				}
				for (const child of node.children) {
					out("this.", child.name, " = new ", promiseClassName(child), "(runtime)")
				}
			})
			out("}")
			out()
			for (const op of node.operations) {
				emitPromiseOperation(op, effectClsName)
			}
		})
		out("}")
		out()
	}

	out("export class PromiseResources {")
	out.indent(() => {
		if (root.operations.length > 0) {
			out("readonly #runtime: ", PromiseSdkRuntime)
		}
		for (const child of root.children) {
			out("readonly ", child.name, ": ", promiseClassName(child))
		}
		out()
		out("constructor(runtime: ", PromiseSdkRuntime, ") {")
		out.indent(() => {
			if (root.operations.length > 0) {
				out("this.#runtime = runtime")
			}
			for (const child of root.children) {
				out("this.", child.name, " = new ", promiseClassName(child), "(runtime)")
			}
		})
		out("}")
		if (root.operations.length > 0) {
			out()
			for (const op of root.operations) {
				emitPromiseOperation(op, "EffectResources")
			}
		}
	})
	out("}")

	return {
		path: "Resources.ts",
		content: cleanGeneratedHeader(out.content),
	}
}

const pathArgEntry = (pa: { readonly wireName: string; readonly argName: string }): string =>
	pa.wireName === pa.argName ? pa.argName : `${JSON.stringify(pa.wireName)}: ${pa.argName}`

export const generateSdkFiles = (forge: Forge): ReadonlyArray<GeneratedFile> => {
	const catalog = buildSurfaceCatalog(forge)
	return [
		generateOperationBindingsFile(catalog.operations),
		generateResourcesFile(catalog.root, catalog.operations),
	]
}
