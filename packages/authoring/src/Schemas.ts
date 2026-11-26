import { CreateAgentBody, CreateAutomationBody, CreateEnvironmentBody } from "@checkfu/sdk/Api"
import { PositiveInt } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"

const metadata = (kind: string) => ({
	type: Schema.optionalKey(Schema.Literal(kind)),
	$schema: Schema.optionalKey(Schema.String),
})

export const projectSchemas = {
	agent: Schema.Struct({ ...CreateAgentBody.fields, ...metadata("agent") }),
	environment: Schema.Struct({ ...CreateEnvironmentBody.fields, ...metadata("environment") }),
	automation: Schema.Struct({
		...CreateAutomationBody.fields,
		...metadata("automation"),
		agent: Schema.Union([
			CreateAutomationBody.fields.agent,
			Schema.Struct({
				path: Schema.String.check(Schema.isMinLength(1)),
				version: Schema.optionalKey(PositiveInt),
			}),
		]),
	}),
}
