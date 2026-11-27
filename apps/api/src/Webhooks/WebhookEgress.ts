import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { truncateError } from "./WebhookDeliveryEngine.ts"
import type { WebhookHttpResult, WebhookHttpSender } from "./WebhookDeliveryEngine.ts"
import {
	WEBHOOK_EGRESS_TARGET_HEADER,
	WEBHOOK_EGRESS_TIMEOUT_HEADER,
} from "./WebhookEgressConfig.ts"
import type { WebhookEgressConfig } from "./WebhookEgressConfig.ts"

export {
	WEBHOOK_EGRESS_TARGET_HEADER,
	WEBHOOK_EGRESS_TIMEOUT_HEADER,
	WEBHOOK_EGRESS_TOKEN_ENV,
	WEBHOOK_EGRESS_URL_ENV,
	WEBHOOK_LOCAL_RUNTIME_ENV,
	WEBHOOK_LOCAL_RUNTIME_VALUE,
	apiWorkerWebhookEgressProps,
	parseWebhookEgressUrl,
	readWebhookEgressConfig,
} from "./WebhookEgressConfig.ts"
export type { WebhookEgressConfig } from "./WebhookEgressConfig.ts"

const EgressEnvelopeSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("response"),
		status: Schema.Int,
	}),
	Schema.Struct({
		kind: Schema.Literal("timeout"),
	}),
	Schema.Struct({
		kind: Schema.Literal("invalid_destination"),
		message: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("network_error"),
		message: Schema.String,
	}),
])

const decodeEgressEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(EgressEnvelopeSchema))

const cancelResponseBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<void> =>
	Effect.ignore(
		Effect.promise(async () => {
			const web = HttpClientResponse.toWeb(response)
			if (Option.isSome(web) && web.value.body !== null) {
				await web.value.body.cancel()
			}
		}),
	)

const sendDirectPublicFetch = (
	client: HttpClient.HttpClient,
	request: Parameters<WebhookHttpSender["send"]>[0],
): Effect.Effect<WebhookHttpResult> =>
	Effect.gen(function* () {
		let httpRequest = HttpClientRequest.post(request.url).pipe(
			HttpClientRequest.bodyText(request.body, "application/json; charset=utf-8"),
		)
		for (const [key, value] of Object.entries(request.headers)) {
			httpRequest = HttpClientRequest.setHeader(httpRequest, key, value)
		}
		const outcome = yield* client.execute(httpRequest).pipe(
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			Effect.flatMap((response) =>
				Effect.as(cancelResponseBody(response), {
					kind: "response" as const,
					status: response.status,
				}),
			),
			Effect.catch((error) =>
				Effect.succeed<WebhookHttpResult>({
					kind: "network_error",
					message: truncateError(error.message || "Network error delivering webhook."),
				}),
			),
			Effect.timeoutOption(Duration.millis(request.timeoutMs)),
		)
		if (Option.isNone(outcome)) {
			return { kind: "timeout" as const }
		}
		return outcome.value
	})

const sendViaPublicEgress = (
	client: HttpClient.HttpClient,
	egressUrl: string,
	egressToken: Redacted.Redacted<string> | null,
	request: Parameters<WebhookHttpSender["send"]>[0],
): Effect.Effect<WebhookHttpResult> =>
	Effect.gen(function* () {
		let httpRequest = HttpClientRequest.post(egressUrl).pipe(
			HttpClientRequest.bodyText(request.body, "application/json; charset=utf-8"),
		)
		for (const [key, value] of Object.entries(request.headers)) {
			httpRequest = HttpClientRequest.setHeader(httpRequest, key, value)
		}
		httpRequest = httpRequest.pipe(
			HttpClientRequest.setHeader(WEBHOOK_EGRESS_TARGET_HEADER, request.url),
			HttpClientRequest.setHeader(WEBHOOK_EGRESS_TIMEOUT_HEADER, String(request.timeoutMs)),
		)
		if (egressToken !== null) {
			httpRequest = HttpClientRequest.setHeader(
				httpRequest,
				"authorization",
				`Bearer ${Redacted.value(egressToken)}`,
			)
		}
		const outerTimeoutMs = request.timeoutMs + 2000
		const outcome = yield* client.execute(httpRequest).pipe(
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			Effect.flatMap((response) =>
				Effect.gen(function* () {
					if (response.status !== 200) {
						yield* cancelResponseBody(response)
						return {
							kind: "egress_error" as const,
							message: truncateError(`Webhook egress proxy returned HTTP ${response.status}.`),
						}
					}
					const text = yield* response.text
					const parsed = yield* decodeEgressEnvelope(text).pipe(
						Effect.orElseSucceed((): WebhookHttpResult => ({
							kind: "egress_error",
							message: "Webhook egress proxy returned a malformed response.",
						})),
					)
					if (
						parsed.kind === "invalid_destination" ||
						parsed.kind === "network_error" ||
						parsed.kind === "egress_error"
					) {
						return { kind: parsed.kind, message: truncateError(parsed.message) }
					}
					return parsed
				}),
			),
			Effect.catch((error) =>
				Effect.succeed<WebhookHttpResult>({
					kind: "egress_error",
					message: truncateError(error.message || "Webhook egress proxy request failed."),
				}),
			),
			Effect.timeoutOption(Duration.millis(outerTimeoutMs)),
		)
		if (Option.isNone(outcome)) {
			return {
				kind: "egress_error" as const,
				message: "Webhook egress proxy timed out before reporting a delivery outcome.",
			}
		}
		return outcome.value
	})

export const makeConfiguredWebhookHttpSender = (
	client: HttpClient.HttpClient,
	config: WebhookEgressConfig,
): WebhookHttpSender => ({
	send: (request) => {
		if (parsePublicHttpsWebhookUrl(request.url) === null) {
			return Effect.succeed<WebhookHttpResult>({
				kind: "invalid_destination",
				message: "Webhook destination URL is not a permitted public HTTPS address.",
			})
		}
		if (config.egressUrl !== null) {
			return sendViaPublicEgress(client, config.egressUrl, config.egressToken, request)
		}
		if (config.localRuntime) {
			return Effect.succeed<WebhookHttpResult>({
				kind: "egress_unconfigured",
				message:
					"Direct webhook delivery is disabled in local workerd because it allows private addresses; configure CHECKFU_WEBHOOK_EGRESS_URL.",
			})
		}
		return sendDirectPublicFetch(client, request)
	},
})

export const makeDefaultWebhookHttpSender = (
	config: WebhookEgressConfig,
): Effect.Effect<WebhookHttpSender> =>
	Effect.map(HttpClient.HttpClient, (client) =>
		makeConfiguredWebhookHttpSender(client, config),
	).pipe(Effect.provide(FetchHttpClient.layer))
