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

export class EnvironmentCreated extends Domain.Event("environment.created", {
	version: PositiveInt,
	name: NonEmptyString,
	description: Schema.NullOr(Schema.String),
	config: EnvironmentConfig,
}) {}

export class EnvironmentAlreadyExists extends Domain.Rejection(
	"EnvironmentAlreadyExists",
	{ environment_id: EnvironmentId },
	{ httpApiStatus: 409, description: "An environment with this id already exists." },
) {}

export class CreateEnvironment extends Domain.Command("CreateEnvironment", {
	input: {
		environment_id: EnvironmentId,
		name: EnvironmentName,
		description: Schema.NullOr(EnvironmentDescription),
		config: EnvironmentConfig,
	},
	events: [EnvironmentCreated],
	rejects: [EnvironmentAlreadyExists],
	reply: {
		version: PositiveInt,
	},
}) {}
