import * as Schema from "effect/Schema"

export const MAX_AGENT_NAME_LENGTH = 256
export const MAX_AGENT_DESCRIPTION_LENGTH = 2048
export const MAX_AGENT_SYSTEM_LENGTH = 100_000

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const AgentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_AGENT_NAME_LENGTH),
)
export const AgentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_AGENT_DESCRIPTION_LENGTH),
)
export const AgentSystem = Schema.String.check(Schema.isMaxCodePoints(MAX_AGENT_SYSTEM_LENGTH))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const AgentModel = Schema.Struct({
	id: NonEmptyString,
})
export type AgentModel = typeof AgentModel.Type
