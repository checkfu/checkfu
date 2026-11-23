import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import { SessionId } from "@checkfu/domain/Session/Session.id"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { configError, formatClientError, isApiErrorEnvelope, usageError } from "../Errors.ts"
import { RootCommand, getClient } from "../RootCommand.ts"
import type { ChatDefaults } from "../SavedConnection.ts"
import { readChatDefaults, readSavedConnection, writeChatDefaults } from "../SavedConnection.ts"
import { writeStderrLine } from "../TerminalOutput.ts"
import { MODEL_PROVIDERS } from "./Deploy.ts"
import { connectToSession } from "./SessionsConnect.ts"

const decodeId = <A>(schema: Schema.Codec<A, string>, label: string, raw: string) =>
	Schema.decodeEffect(schema)(raw).pipe(
		Effect.mapError(() => configError(`The API returned an unexpected ${label} ID.`)),
	)

const shellQuote = (value: string): string =>
	/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

const isNotFound = (error: unknown): boolean =>
	isApiErrorEnvelope(error) && error.error.type === "not_found_error"

const whilePending = { while: isNotFound, schedule: Schedule.spaced("300 millis"), times: 20 }

const stillUsable = <A extends { readonly archived_at: unknown }, E, R>(
	lookup: Effect.Effect<A, E, R>,
) =>
	lookup.pipe(
		Effect.map(Option.liftPredicate((resource) => resource.archived_at === null)),
		Effect.catchIf(isNotFound, () => Effect.succeedNone),
	)

export const chatCommand = Command.make(
	"chat",
	{
		model: Flag.String("model").pipe(
			Flag.withMetavar("ID"),
			Flag.withDescription(
				`Model for the chat agent (defaults to the model chosen at deploy, then the one you used last, e.g. ${MODEL_PROVIDERS.map((provider) => provider.model).join(" or ")})`,
			),
			Flag.optional,
		),
	},
	(input) =>
		Effect.gen(function* () {
			const client = yield* getClient
			// The remembered agent and environment are a cache: a problem reading or writing
			// it costs a duplicate agent next time, never the chat itself.
			const remembered = yield* readChatDefaults.pipe(
				Effect.catch((error) =>
					Effect.as(
						writeStderrLine(`Starting without remembered chat defaults: ${error.message}`),
						Option.none<ChatDefaults>(),
					),
				),
			)
			const defaults = Option.getOrUndefined(
				Option.filter(remembered, (entry) => entry.url === client.baseUrl),
			)

			const model = yield* Option.match(input.model, {
				onSome: (chosen) => Effect.succeed(chosen),
				onNone: () =>
					Effect.map(
						readSavedConnection,
						(connection) =>
							Option.getOrUndefined(
								Option.filter(connection, (entry) => entry.url === client.baseUrl),
							)?.model ?? defaults?.model,
					),
			})
			if (model === undefined) {
				return yield* usageError(
					`Pass --model to choose the agent's model (for example ${MODEL_PROVIDERS.map((provider) => provider.model).join(" or ")}).`,
				)
			}

			let agentId: AgentId | undefined
			const savedAgentId = Option.flatMap(
				Option.fromNullishOr(defaults?.agents[model]),
				Schema.decodeOption(AgentId),
			)
			if (Option.isSome(savedAgentId)) {
				const agent = yield* stillUsable(
					client.api.agents.get({ params: { agent_id: savedAgentId.value } }),
				).pipe(Effect.mapError(formatClientError))
				if (Option.isSome(agent) && agent.value.model.id === model) {
					agentId = agent.value.id
				}
			}
			if (agentId === undefined) {
				const agent = yield* client.api.agents
					.create({
						payload: {
							name: "Assistant",
							model,
							system: "You are a concise, helpful assistant.",
						},
					})
					.pipe(Effect.mapError(formatClientError))
				agentId = yield* decodeId(AgentId, "agent", agent.id)
			}

			let environmentId: EnvironmentId | undefined
			const savedEnvironmentId = Option.flatMap(
				Option.fromNullishOr(defaults?.environment_id),
				Schema.decodeOption(EnvironmentId),
			)
			if (Option.isSome(savedEnvironmentId)) {
				const environment = yield* stillUsable(
					client.api.environments.get({
						params: { environment_id: savedEnvironmentId.value },
					}),
				).pipe(Effect.mapError(formatClientError))
				environmentId = Option.getOrUndefined(environment)?.id
			}
			if (environmentId === undefined) {
				const environment = yield* client.api.environments
					.create({ payload: { name: "default" } })
					.pipe(Effect.mapError(formatClientError))
				environmentId = yield* decodeId(EnvironmentId, "environment", environment.id)
			}

			yield* writeChatDefaults({
				url: client.baseUrl,
				model,
				environment_id: environmentId,
				agents: { ...defaults?.agents, [model]: agentId },
			}).pipe(
				Effect.catch((error) =>
					writeStderrLine(`This agent will not be reused next time: ${error.message}`),
				),
			)

			const session = yield* client.api.sessions
				.create({ payload: { agent: agentId, environment_id: environmentId } })
				.pipe(Effect.retry(whilePending), Effect.mapError(formatClientError))
			const sessionId = yield* decodeId(SessionId, "session", session.id)
			const target = Option.isSome((yield* RootCommand).baseUrl)
				? ` --base-url ${shellQuote(client.baseUrl)}`
				: ""
			yield* writeStderrLine(`Resume later with: checkfu${target} sessions connect ${sessionId}`)
			return yield* connectToSession(client, sessionId)
		}),
).pipe(
	Command.withDescription("Start a new session with a ready-made agent and chat with it"),
	Command.withExamples([
		{ command: "checkfu chat", description: "Chat with the default assistant" },
		{
			command: 'echo "Summarize this" | checkfu chat',
			description: "Send one message and print the reply",
		},
	]),
)
