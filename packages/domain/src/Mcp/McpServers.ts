import {
	MAX_MCP_SERVERS,
	MAX_MCP_TOOL_POLICIES,
	McpServerName,
	McpServerUrl,
	PermissionPolicy,
} from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"

export {
	MAX_MCP_SERVERS,
	MAX_MCP_TOOL_POLICIES,
	McpServerName,
	PermissionPolicy,
} from "@checkfu/sdk/Schemas"

export const MAX_MCP_SERVERS_TEXT_LENGTH = 65_536

/**
 * Who decides whether a server's tools run: the agent's author, for the whole
 * server and tool by tool. A tool neither covers is decided by what the server
 * says about it (see {@link evaluateMcpPermission}).
 */
export const McpToolPermissions = Schema.Struct({
	default: Schema.optionalKey(PermissionPolicy),
	tools: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
				permission_policy: PermissionPolicy,
			}),
		).check(Schema.isMaxLength(MAX_MCP_TOOL_POLICIES)),
	),
})
export type McpToolPermissions = typeof McpToolPermissions.Type

/**
 * Whether a call to one of a server's tools runs on its own or waits for a
 * person. The author's policy for the tool wins, then their policy for the
 * server. With neither, a tool the server marks read-only runs and every other
 * tool asks: the mark is the server's own claim, so it only ever decides when
 * the author said nothing.
 */
export const evaluateMcpPermission = (
	permissions: McpToolPermissions | undefined,
	tool: string,
	readOnly: boolean,
): "allow" | "ask" => {
	const policy =
		permissions?.tools?.find((entry) => entry.name === tool)?.permission_policy ??
		permissions?.default
	if (policy === undefined) {
		return readOnly ? "allow" : "ask"
	}
	return policy === "always_allow" ? "allow" : "ask"
}

export const McpServer = Schema.Struct({
	type: Schema.Literal("url"),
	name: McpServerName,
	url: McpServerUrl,
	permissions: Schema.optionalKey(McpToolPermissions),
})
export type McpServer = typeof McpServer.Type

/** An agent's server, as one session uses it: with the credential it was bound to, or none. */
export const McpServerBinding = Schema.Struct({
	name: McpServerName,
	url: McpServerUrl,
	credential_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
	permissions: Schema.optionalKey(McpToolPermissions),
})
export type McpServerBinding = typeof McpServerBinding.Type

/**
 * A server list as the model carries it: JSON text, empty for no servers. The
 * model compares and copies it and never looks inside, so its rules stay
 * provable; whoever sends or reads it uses the functions below.
 */
export const McpServersText = Schema.String.check(Schema.isMaxLength(MAX_MCP_SERVERS_TEXT_LENGTH))

export const listText = <
	S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
	item: S,
	max: number = MAX_MCP_SERVERS,
) => {
	const codec = Schema.fromJsonString(
		Schema.toCodecJson(Schema.Array(item).check(Schema.isMaxLength(max))),
	)
	const encode = Schema.encodeSync(codec)
	const decode = Schema.decodeUnknownSync(codec)
	return {
		encode: (items: ReadonlyArray<S["Type"]>): string => (items.length === 0 ? "" : encode(items)),
		decode: (text: string | undefined): ReadonlyArray<S["Type"]> =>
			text === undefined || text === "" ? [] : decode(text),
	}
}

export const McpServerList = listText(McpServer)
export const McpServerBindingList = listText(McpServerBinding)
