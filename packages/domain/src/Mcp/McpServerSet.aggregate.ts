import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { McpServersText } from "./McpServers.ts"

/** The id of whatever the servers belong to: an agent version, or a session. */
export const McpServerSetId = Schema.String.check(Schema.isMinLength(1)).pipe(
	Schema.brand("McpServerSetId"),
)
export type McpServerSetId = typeof McpServerSetId.Type

export class McpServersRecorded extends Domain.Event("mcp_servers.recorded", {
	servers: McpServersText,
}) {}

export class RecordMcpServers extends Domain.Command("RecordMcpServers", {
	input: {
		set_id: McpServerSetId,
		servers: McpServersText,
	},
	events: [McpServersRecorded],
}) {}

export const McpServerSetState = Schema.Struct({
	recorded: Schema.Boolean,
	servers: Schema.String,
})
export type McpServerSetState = typeof McpServerSetState.Type

export const McpServerSetStateSnapshot = versionedSnapshot({
	current: 1,
	schema: McpServerSetState,
})

/**
 * The MCP servers of one agent version, or of one session with the credential
 * each was bound to. They are recorded once, before the version or session
 * they belong to exists, and never change: whoever reads them later reads what
 * was decided then.
 */
export class McpServerSet extends Domain.Aggregate("McpServerSet", {
	id: McpServerSetId,
	state: McpServerSetStateSnapshot,
	initial: { recorded: false, servers: "" },
	commands: [RecordMcpServers],
	events: [McpServersRecorded],
	keyOf: (cmd) => cmd.set_id,
	invariants: {
		NothingRecordedMeansNoServers: (s) => [s.recorded, s.servers === ""].some((ok) => ok),
	},
	transitions: {
		RecordedServersNeverChange: ({ before, after }) =>
			[!before.recorded, [after.recorded, after.servers === before.servers].every((ok) => ok)].some(
				(ok) => ok,
			),
	},
	decide: {
		RecordMcpServers: (state, cmd) =>
			state.recorded ? [] : [new McpServersRecorded({ servers: cmd.servers })],
	},
	evolve: {
		"mcp_servers.recorded": (state, e) =>
			state.recorded ? state : { recorded: true, servers: e.servers },
	},
}) {}
