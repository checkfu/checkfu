import * as Domain from "@alchemy.run/domain"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { EnvironmentView } from "./Environment/EnvironmentView.view.ts"

export class Environments extends Domain.Model("Environments", {
	aggregates: [Environment],
	views: [EnvironmentView],
	sometimes: {
		AnEnvironmentIsUpdated: (m) =>
			m.Environment.some((e) =>
				[e.state.status === "active", e.state.version >= 2].every((ok) => ok),
			),
		AnEnvironmentIsArchived: (m) => m.Environment.some((e) => e.state.status === "archived"),
		AnEnvironmentIsDeleted: (m) => m.Environment.some((e) => e.state.status === "deleted"),
	},
}) {}

export class EnvironmentsApi extends Domain.Api("EnvironmentsApi", {
	model: Environments,
	commands: ["CreateEnvironment", "UpdateEnvironment", "ArchiveEnvironment", "DeleteEnvironment"],
	views: ["EnvironmentView"],
}) {}
