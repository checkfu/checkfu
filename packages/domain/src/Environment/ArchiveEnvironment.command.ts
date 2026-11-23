import * as Domain from "@alchemy.run/domain"
import { EnvironmentId } from "./Environment.id.ts"
import { EnvironmentNotFound } from "./EnvironmentNotFound.rejection.ts"

export class EnvironmentArchived extends Domain.Event("environment.archived") {}

export class ArchiveEnvironment extends Domain.Command("ArchiveEnvironment", {
	input: {
		environment_id: EnvironmentId,
	},
	events: [EnvironmentArchived],
	rejects: [EnvironmentNotFound],
}) {}
