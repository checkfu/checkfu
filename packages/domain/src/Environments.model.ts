import * as Domain from "@alchemy.run/domain"
import { Environment } from "./Environment/Environment.aggregate.ts"
import { EnvironmentView } from "./Environment/EnvironmentView.view.ts"

export class Environments extends Domain.Model("Environments", {
	aggregates: [Environment],
	views: [EnvironmentView],
	invariants: {
		EnvironmentViewMatchesEnvironment: (m) =>
			[
				m.Environment.every((e) => {
					const view = m.EnvironmentView.find((v) => v.id === e.id)
					if (e.state.status === "" || e.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === e.id,
						view.state.version === e.state.version,
						view.state.name === e.state.name,
						!!view.state.archived_at === (e.state.status === "archived"),
					].every((ok) => ok)
				}),
				m.EnvironmentView.every((v) =>
					m.Environment.some((e) =>
						[e.id === v.id, e.state.status !== "", e.state.status !== "deleted"].every((ok) => ok),
					),
				),
			].every((ok) => ok),
		EnvironmentViewConfigMatchesEnvironment: (m) =>
			m.Environment.every((e) => {
				const view = m.EnvironmentView.find((v) => v.id === e.id)
				if (view === undefined) {
					return true
				}
				if (e.state.config === null) {
					return false
				}
				const projected = view.state.config.networking
				const committed = e.state.config.networking
				return [
					view.state.description === e.state.description,
					projected.type === committed.type,
					projected.type !== "limited" ||
						committed.type !== "limited" ||
						(projected.allow_mcp_servers === committed.allow_mcp_servers &&
							projected.allow_package_managers === committed.allow_package_managers &&
							projected.allowed_hosts.length === committed.allowed_hosts.length &&
							projected.allowed_hosts.every(
								(host, index) => host === committed.allowed_hosts[index],
							)),
				].every((ok) => ok)
			}),
	},
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
