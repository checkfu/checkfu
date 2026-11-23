import * as Domain from "@alchemy.run/domain"
import { EnvironmentId } from "./Environment.id.ts"
import { EnvironmentNotFound } from "./EnvironmentNotFound.rejection.ts"

export class EnvironmentDeleted extends Domain.Event("environment.deleted") {}

export class DeleteEnvironment extends Domain.Command("DeleteEnvironment", {
	input: {
		environment_id: EnvironmentId,
	},
	events: [EnvironmentDeleted],
	rejects: [EnvironmentNotFound],
}) {}
