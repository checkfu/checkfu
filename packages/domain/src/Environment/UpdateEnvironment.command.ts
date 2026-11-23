import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import {
	EnvironmentConfig,
	EnvironmentDescription,
	EnvironmentName,
	NonEmptyString,
	PositiveInt,
} from "./EnvironmentTypes.ts"
import { EnvironmentId } from "./Environment.id.ts"
import { EnvironmentArchivedError } from "./EnvironmentArchived.rejection.ts"
import { EnvironmentNotFound } from "./EnvironmentNotFound.rejection.ts"

export class EnvironmentUpdated extends Domain.Event("environment.updated", {
	version: PositiveInt,
	name: NonEmptyString,
	description: Schema.NullOr(Schema.String),
	config: EnvironmentConfig,
}) {}

export class EnvironmentVersionConflict extends Domain.Rejection(
	"EnvironmentVersionConflict",
	{
		environment_id: EnvironmentId,
		expected_version: PositiveInt,
		current_version: PositiveInt,
	},
	{ httpApiStatus: 409, description: "Environment version does not match." },
) {}

export class UpdateEnvironment extends Domain.Command("UpdateEnvironment", {
	input: {
		environment_id: EnvironmentId,
		expected_version: PositiveInt,
		changes: Schema.Struct({
			name: Schema.optionalKey(EnvironmentName),
			description: Schema.optionalKey(Schema.NullOr(EnvironmentDescription)),
			config: Schema.optionalKey(EnvironmentConfig),
		}),
	},
	events: [EnvironmentUpdated],
	rejects: [EnvironmentNotFound, EnvironmentArchivedError, EnvironmentVersionConflict],
	reply: {
		version: PositiveInt,
	},
}) {}
