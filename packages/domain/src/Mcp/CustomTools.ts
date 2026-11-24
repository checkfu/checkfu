import { CustomTool, MAX_CUSTOM_TOOLS } from "@checkfu/sdk/Schemas"
import { McpServerSetId } from "./McpServerSet.aggregate.ts"
import { listText } from "./McpServers.ts"

export {
	CustomTool,
	MAX_CUSTOM_TOOLS,
	MAX_CUSTOM_TOOL_INPUT_SCHEMA_LENGTH,
} from "@checkfu/sdk/Schemas"

/**
 * An agent version's custom tools, kept the way its MCP servers are: as text
 * recorded once under the version, before the version exists.
 */
export const CustomToolList = listText(CustomTool, MAX_CUSTOM_TOOLS)

export const customToolSetId = (versionId: string): McpServerSetId =>
	McpServerSetId.make(`${versionId}/custom_tools`)
