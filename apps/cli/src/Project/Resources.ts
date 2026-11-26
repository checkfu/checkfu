import type { ResourceKind } from "@checkfu/authoring/project"
import { createHash } from "node:crypto"
import {
	UpdateAgentBody,
	UpdateAutomationBody,
	UpdateEnvironmentBody,
	isPendingResource,
} from "@checkfu/sdk/Api"
import type { Agent, ApiError, Automation, Environment, PendingResource } from "@checkfu/sdk/Api"
import { agentProjectDefinition, canonicalProjectJson } from "@checkfu/authoring/project"
import {
	AgentId,
	AutomationId,
	DEFAULT_ENVIRONMENT_CONFIG,
	EnvironmentId,
} from "@checkfu/sdk/Schemas"
import * as Effect from "effect/Effect"
import * as HttpClientError from "effect/http/HttpClientError"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type { CheckfuClient } from "../Client.ts"
import {
	apiErrorStatus,
	formatClientError,
	isApiErrorEnvelope,
	isTransientHttpError,
	isTransientHttpStatus,
	networkFailure,
	usageError,
} from "../Errors.ts"
import type { CliFailure } from "../Errors.ts"
import type { Definition } from "./Source.ts"

export type Resource = Agent | Environment | Automation
export const fingerprint = (value: unknown): string =>
	createHash("sha256").update(canonicalProjectJson(value)).digest("hex")

export const remoteBody = (resource: Resource): Definition => {
	const { name, description } = resource
	switch (resource.type) {
		case "agent":
			return agentProjectDefinition(resource)
		case "environment":
			return { kind: "environment", body: { name, description, config: resource.config } }
		case "automation": {
			const { agent, environment_id, initial_events, schedule } = resource
			return {
				kind: "automation",
				body: {
					name,
					description,
					environment_id,
					initial_events,
					schedule,
					agent: { type: "agent", id: agent.id, version: agent.version },
				},
			}
		}
	}
}

export const desiredBody = (definition: Definition): Definition => {
	switch (definition.kind) {
		case "agent":
			return agentProjectDefinition(definition.body)
		case "environment": {
			const { name, description, config } = definition.body
			return {
				kind: "environment",
				body: {
					name,
					description: description ?? null,
					config: config ?? DEFAULT_ENVIRONMENT_CONFIG,
				},
			}
		}
		case "automation": {
			const { name, description, agent, environment_id, initial_events, schedule } = definition.body
			return {
				kind: "automation",
				body: {
					name,
					description: description ?? null,
					agent: typeof agent === "string" ? agent : agent.version === undefined ? agent.id : agent,
					environment_id,
					initial_events: [
						{
							type: "user.message",
							content: [
								{
									type: "text",
									text: initial_events
										.flatMap((event) => event.content.map((block) => block.text))
										.join("\n"),
								},
							],
						},
					],
					schedule,
				},
			}
		}
	}
}

export const configurationFields = (kind: ResourceKind, body: Definition["body"]) =>
	kind === "agent" ? { mcp_servers: [], tools: [], ...body } : body

export const configurationChanges = (
	current: Resource,
	desired: Definition["body"],
): Record<string, Schema.Json> => {
	const before = new Map<string, unknown>(
		Object.entries(configurationFields(current.type, remoteBody(current).body)),
	)
	return Object.fromEntries(
		Object.entries<Schema.Json>(configurationFields(current.type, desired)).filter(
			([key, value]) => fingerprint(before.get(key)) !== fingerprint(value),
		),
	)
}

export const resourceRevision = (resource: Resource): number | undefined =>
	resource.type === "automation" ? resource.revision : resource.version

export const automationDependencyIds = (body: {
	readonly agent: string | { readonly id: string }
	readonly environment_id: string
}) => [typeof body.agent === "string" ? body.agent : body.agent.id, body.environment_id]

export const pinAutomationAgent = (api: CheckfuClient["api"], definition: Definition) => {
	if (definition.kind !== "automation" || typeof definition.body.agent !== "string") {
		return Effect.succeed(definition)
	}
	const { agent } = definition.body
	return api.agents.get({ params: { agent_id: AgentId.make(agent) }, query: {} }).pipe(
		Effect.mapBoth({
			onSuccess: (resource): Definition => ({
				...definition,
				body: {
					...definition.body,
					agent: { type: "agent", id: resource.id, version: resource.version },
				},
			}),
			onFailure: formatClientError,
		}),
	)
}

export const listLiveAutomations = (api: CheckfuClient["api"]) =>
	Effect.gen(function* () {
		const live: Array<Automation> = []
		const seen = new Set<string>()
		let token: string | undefined
		for (;;) {
			const page = yield* api.automations
				.list({ query: { limit: 100, ...(token === undefined ? {} : { page: token }) } })
				.pipe(Effect.mapError(formatClientError))
			live.push(...page.data.filter(({ archived_at }) => archived_at === null))
			const next = page.next_page
			if (next === null) {
				return live
			}
			if (seen.has(next)) {
				return yield* networkFailure("The API returned a repeated automation page token.")
			}
			seen.add(next)
			token = next
		}
	})

type ClientError = ApiError | HttpClientError.HttpClientError | Schema.SchemaError

const retrieve = (
	api: CheckfuClient["api"],
	kind: ResourceKind,
	id: string,
): Effect.Effect<Resource, ClientError> => {
	switch (kind) {
		case "agent":
			return api.agents.get({ params: { agent_id: AgentId.make(id) }, query: {} })
		case "environment":
			return api.environments.get({ params: { environment_id: EnvironmentId.make(id) } })
		case "automation":
			return api.automations.get({ params: { automation_id: AutomationId.make(id) } })
	}
}

export const readRemote = (api: CheckfuClient["api"], kind: ResourceKind, id: string) =>
	retrieve(api, kind, id).pipe(
		Effect.catch((error) =>
			isApiErrorEnvelope(error) && error.error.type === "not_found_error"
				? Effect.succeed(null)
				: Effect.fail(formatClientError(error)),
		),
	)

const transientRead = (error: ClientError): boolean =>
	isApiErrorEnvelope(error)
		? error.error.type === "not_found_error" || isTransientHttpStatus(apiErrorStatus(error))
		: HttpClientError.isHttpClientError(error) && isTransientHttpError(error)

export const confirmCreateReplay = (
	api: CheckfuClient["api"],
	kind: ResourceKind,
	id: string,
	matches: (resource: Resource) => boolean,
) =>
	retrieve(api, kind, id).pipe(
		Effect.retry({
			while: (error) =>
				transientRead(error) &&
				!(isApiErrorEnvelope(error) && error.error.type === "not_found_error"),
			schedule: Schedule.spaced("250 millis"),
			times: 20,
		}),
		Effect.mapError(formatClientError),
		Effect.filterOrFail(matches, () =>
			usageError(
				`Current resource ${id} differs from the confirmed create. Run apply again to reconcile its state.`,
			),
		),
	)

export const awaitResource = (
	api: CheckfuClient["api"],
	result: Resource | PendingResource,
	matches: (resource: Resource) => boolean,
): Effect.Effect<Resource, CliFailure> => {
	if (!isPendingResource(result)) {
		return matches(result)
			? Effect.succeed(result)
			: Effect.fail(
					networkFailure(
						`The API returned unexpected configuration for ${result.id}. Run apply again to check its state.`,
					),
				)
	}
	if (result.type !== "agent" && result.type !== "environment" && result.type !== "automation") {
		return Effect.fail(networkFailure(`Unexpected pending resource ${result.type}.`))
	}
	return retrieve(api, result.type, result.id).pipe(
		Effect.map((resource) => (matches(resource) ? resource : null)),
		Effect.catch((error) =>
			transientRead(error) ? Effect.succeed(null) : Effect.fail(formatClientError(error)),
		),
		Effect.repeat({
			schedule: Schedule.spaced("250 millis"),
			until: (resource) => resource !== null,
		}),
		Effect.filterOrFail(
			(resource): resource is Resource => resource !== null,
			() => networkFailure(`Could not confirm ${result.id}.`),
		),
		Effect.timeoutOrElse({
			duration: "20 seconds",
			orElse: () =>
				Effect.fail(
					networkFailure(`Timed out waiting for ${result.id}. Run apply again to check its state.`),
				),
		}),
	)
}

export const createResource = (
	api: CheckfuClient["api"],
	definition: Definition,
	key: string,
): Effect.Effect<Resource | PendingResource, ClientError> => {
	const headers = { "idempotency-key": key }
	switch (definition.kind) {
		case "agent":
			return api.agents.create({ headers, payload: definition.body })
		case "environment":
			return api.environments.create({ headers, payload: definition.body })
		case "automation":
			return api.automations.create({ headers, payload: definition.body })
	}
}

export const updateResource = (
	api: CheckfuClient["api"],
	definition: Definition,
	current: Resource,
): Effect.Effect<Resource | PendingResource, CliFailure> => {
	const changes = configurationChanges(current, definition.body)
	switch (current.type) {
		case "agent":
			return Schema.decodeEffect(UpdateAgentBody)({
				...changes,
				version: current.version,
			}).pipe(
				Effect.flatMap((payload) =>
					api.agents.update({ params: { agent_id: current.id }, payload }),
				),
				Effect.mapError(formatClientError),
			)
		case "environment":
			return Schema.decodeEffect(UpdateEnvironmentBody)({
				...changes,
				version: current.version,
			}).pipe(
				Effect.flatMap((payload) =>
					api.environments.update({ params: { environment_id: current.id }, payload }),
				),
				Effect.mapError(formatClientError),
			)
		case "automation":
			return Schema.decodeEffect(UpdateAutomationBody)({
				...changes,
				revision: current.revision,
			}).pipe(
				Effect.flatMap((payload) =>
					api.automations.update({ params: { automation_id: current.id }, payload }),
				),
				Effect.mapError(formatClientError),
			)
	}
}

export const archiveResource = (
	api: CheckfuClient["api"],
	current: Resource,
): Effect.Effect<Resource | PendingResource, CliFailure> => {
	switch (current.type) {
		case "agent":
			return api.agents
				.archiveIfCurrent({
					params: { agent_id: current.id },
					payload: { version: current.version },
				})
				.pipe(Effect.mapError(formatClientError))
		case "environment":
			return api.environments
				.archiveIfCurrent({
					params: { environment_id: current.id },
					payload: { version: current.version },
				})
				.pipe(Effect.mapError(formatClientError))
		case "automation":
			return api.automations
				.archiveIfCurrent({
					params: { automation_id: current.id },
					payload: { revision: current.revision },
				})
				.pipe(Effect.mapError(formatClientError))
	}
}
