import { AgentId } from "@checkfu/agents/Agent/Agent.id"
import { EnvironmentId } from "@checkfu/environments/Environment/Environment.id"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Stdio from "effect/Stdio"
import type { CheckfuClient } from "./Client.ts"
import { type CliFailure, apiFailure, isApiErrorEnvelope } from "./Errors.ts"
import { isPlainRecord } from "./Input.ts"
import { writeStderrLine } from "./TerminalOutput.ts"

const extractAgentId = (payload: unknown): string | undefined => {
	if (!isPlainRecord(payload)) return undefined
	const agent = payload["agent"]
	if (typeof agent === "string") return agent
	if (isPlainRecord(agent) && typeof agent["id"] === "string") return agent["id"]
	return typeof payload["agent_id"] === "string" ? payload["agent_id"] : undefined
}

export const diagnoseSessionCreateNotFound = (
	client: CheckfuClient,
	payload: unknown,
	fallbackMessage: string,
): Effect.Effect<CliFailure> =>
	Effect.gen(function* () {
		const rawAgentId = extractAgentId(payload)
		if (rawAgentId !== undefined) {
			const decodedAgent = Schema.decodeUnknownOption(AgentId)(rawAgentId)
			if (Option.isSome(decodedAgent)) {
				const agentCheck = yield* Effect.result(
					client.api.agents.get({ params: { agent_id: decodedAgent.value } }),
				)
				if (
					agentCheck._tag === "Failure" &&
					isApiErrorEnvelope(agentCheck.failure) &&
					agentCheck.failure.error.type === "not_found_error"
				) {
					return apiFailure(404, "not_found_error", `Agent "${rawAgentId}" was not found.`)
				}
			}
		}

		const envId =
			isPlainRecord(payload) && typeof payload["environment_id"] === "string"
				? payload["environment_id"]
				: undefined
		if (envId !== undefined) {
			const decodedEnv = Schema.decodeUnknownOption(EnvironmentId)(envId)
			if (Option.isSome(decodedEnv)) {
				const envCheck = yield* Effect.result(
					client.api.environments.get({ params: { environment_id: decodedEnv.value } }),
				)
				if (
					envCheck._tag === "Failure" &&
					isApiErrorEnvelope(envCheck.failure) &&
					envCheck.failure.error.type === "not_found_error"
				) {
					return apiFailure(404, "not_found_error", `Environment "${envId}" was not found.`)
				}
			}
		}

		return apiFailure(404, "not_found_error", fallbackMessage)
	})

export const ensureIdempotencyKeyHeader = (
	client: CheckfuClient,
	headers: Record<string, string>,
): Effect.Effect<Record<string, string>, CliFailure, Stdio.Stdio> =>
	Effect.gen(function* () {
		if (headers["idempotency-key"] !== undefined) return headers
		const key = yield* client.generateIdempotencyKey()
		yield* writeStderrLine(`Idempotency-Key: ${key}`)
		return { ...headers, "idempotency-key": key }
	})
