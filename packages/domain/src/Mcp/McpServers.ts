import {
	AgentTools,
	McpServerCredentials,
	McpServerName,
	McpServerUrl,
	McpServers,
} from "@checkfu/sdk/Schemas"
import type {
	AgentTool,
	EnvironmentNetworking,
	McpServer,
	McpServerCredential,
} from "@checkfu/sdk/Schemas"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export {
	AgentTool,
	AgentTools,
	CustomTool,
	McpToolset,
	MAX_MCP_SERVERS,
	McpServer,
	McpServerCredential,
	McpServerName,
	McpServers,
} from "@checkfu/sdk/Schemas"

export const MAX_MCP_SERVERS_TEXT_LENGTH = 65_536
export const MAX_MCP_SERVER_CREDENTIALS_TEXT_LENGTH = 16_384
export const MAX_AGENT_TOOLS_TEXT_LENGTH = 200_000

export const McpServersText = Schema.String.check(Schema.isMaxLength(MAX_MCP_SERVERS_TEXT_LENGTH))
export const McpServerCredentialsText = Schema.String.check(
	Schema.isMaxLength(MAX_MCP_SERVER_CREDENTIALS_TEXT_LENGTH),
)

export const AgentToolsText = Schema.String.check(Schema.isMaxLength(MAX_AGENT_TOOLS_TEXT_LENGTH))

export const NO_MCP_SERVERS = "[]"
export const NO_MCP_SERVER_CREDENTIALS = "[]"
export const NO_AGENT_TOOLS = "[]"

export const McpServerBinding = Schema.Struct({
	name: McpServerName,
	url: McpServerUrl,
	credential_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
	vault_id: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
})
export type McpServerBinding = typeof McpServerBinding.Type

const checkedText = <A>(list: Schema.Codec<A, string>, text: Schema.Schema<string>) => {
	const encode = Schema.encodeUnknownOption(list)
	const fits = Schema.is(text)
	return (value: A): string | undefined => Option.getOrUndefined(Option.filter(encode(value), fits))
}

const serversJson = Schema.fromJsonString(McpServers)
const credentialsJson = Schema.fromJsonString(McpServerCredentials)
const toolsJson = Schema.fromJsonString(AgentTools)
const readTools = Schema.decodeOption(toolsJson)
const readServers = Schema.decodeOption(serversJson)
const readCredentials = Schema.decodeOption(credentialsJson)

export const encodeMcpServers = checkedText(serversJson, McpServersText)
export const encodeMcpServerCredentials = checkedText(credentialsJson, McpServerCredentialsText)
export const encodeAgentTools = checkedText(toolsJson, AgentToolsText)

export const decodeMcpServers = (text: string | undefined): ReadonlyArray<McpServer> =>
	text === undefined ? [] : Option.getOrElse(readServers(text), () => [])

export const decodeMcpServerCredentials = (
	text: string | undefined,
): ReadonlyArray<McpServerCredential> =>
	text === undefined ? [] : Option.getOrElse(readCredentials(text), () => [])

export const decodeAgentTools = (text: string | undefined): ReadonlyArray<AgentTool> =>
	text === undefined ? [] : Option.getOrElse(readTools(text), () => [])

export const mcpHostAllowed = (
	networking: EnvironmentNetworking | null | undefined,
	host: string,
): boolean =>
	networking === null ||
	networking === undefined ||
	networking.type === "unrestricted" ||
	networking.allow_mcp_servers ||
	networking.allowed_hosts.includes(host)

export const bindMcpServers = (
	servers: ReadonlyArray<McpServer>,
	credentials: ReadonlyArray<McpServerCredential>,
): ReadonlyArray<McpServerBinding> =>
	servers.map((server) => {
		const pair = credentials.find((bound) => bound.mcp_server_name === server.name)
		return {
			name: server.name,
			url: server.url,
			credential_id: pair?.credential_id ?? null,
			vault_id: pair?.vault_id ?? null,
		}
	})

export interface CredentialRequest {
	readonly servers: ReadonlyArray<McpServer>
	readonly explicit: ReadonlyArray<{
		readonly mcp_server_name: string
		readonly credential_id: string
		readonly vault_id: string | null
		readonly target: string | null
	}>
	readonly vaults: ReadonlyArray<{
		readonly id: string
		readonly credentials: ReadonlyArray<{
			readonly credential_id: string
			readonly mcp_server_url: string
		}>
	}>
}

export const resolveMcpServerCredentials = ({
	servers,
	explicit,
	vaults,
}: CredentialRequest): Result.Result<ReadonlyArray<McpServerCredential>, string> => {
	const named = new Map<string, (typeof explicit)[number]>()
	for (const pair of explicit) {
		if (named.has(pair.mcp_server_name)) {
			return Result.fail(`mcp_server_credentials names "${pair.mcp_server_name}" more than once.`)
		}
		const server = servers.find((declared) => declared.name === pair.mcp_server_name)
		if (server === undefined) {
			return Result.fail(`The agent has no MCP server named "${pair.mcp_server_name}".`)
		}
		if (pair.vault_id === null || pair.target !== server.url) {
			return Result.fail(
				`Credential ${pair.credential_id} is not an active credential for MCP server "${server.name}".`,
			)
		}
		named.set(pair.mcp_server_name, pair)
	}
	const held = new Map(vaults.map((vault) => [vault.id, vault.credentials]))
	const resolved: Array<McpServerCredential> = []
	for (const server of servers) {
		const pair = named.get(server.name)
		const matches = new Map(
			pair !== undefined && pair.vault_id !== null
				? [[pair.credential_id, pair.vault_id] as const]
				: [...held].flatMap(([vault_id, credentials]) =>
						credentials
							.filter((credential) => credential.mcp_server_url === server.url)
							.map((credential) => [credential.credential_id, vault_id] as const),
					),
		)
		if (matches.size > 1) {
			return Result.fail(
				`More than one credential matches MCP server "${server.name}". Name one in mcp_server_credentials.`,
			)
		}
		for (const [credential_id, vault_id] of matches) {
			resolved.push({ mcp_server_name: server.name, credential_id, vault_id })
		}
	}
	return Result.succeed(resolved)
}
