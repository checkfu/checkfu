import { MAX_MCP_SERVERS, McpServer, McpServerBinding } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"

export { MAX_MCP_SERVERS, McpServer, McpServerBinding, McpServerName } from "@checkfu/sdk/Schemas"

export const MAX_MCP_SERVERS_TEXT_LENGTH = 65_536

/**
 * A server list as the model carries it: JSON text, empty for no servers. The
 * model compares and copies it and never looks inside, so its rules stay
 * provable; whoever sends or reads it uses the functions below.
 */
export const McpServersText = Schema.String.check(Schema.isMaxLength(MAX_MCP_SERVERS_TEXT_LENGTH))

const listText = <
	S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
	item: S,
) => {
	const codec = Schema.fromJsonString(
		Schema.toCodecJson(Schema.Array(item).check(Schema.isMaxLength(MAX_MCP_SERVERS))),
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
