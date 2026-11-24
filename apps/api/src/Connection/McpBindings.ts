import { MAX_MCP_SERVERS_TEXT_LENGTH, McpServerBindingList } from "@checkfu/domain/Mcp/McpServers"
import type { McpServer, McpServerBinding } from "@checkfu/domain/Mcp/McpServers"

export interface StoredCredential {
	readonly credential_id: string
	readonly mcp_server_url: string
}

export interface ExplicitBinding {
	readonly mcp_server_name: string
	readonly credential_id: string
	/** Where the credential is stored for; null when it is not an active credential. */
	readonly mcp_server_url: string | null
}

export type BindingResolution =
	| { readonly ok: true; readonly bindings: ReadonlyArray<McpServerBinding> }
	| { readonly ok: false; readonly message: string }

const refuse = (message: string): BindingResolution => ({ ok: false, message })

// A session keeps the agent's policy for each server, as it was when the session began.
const bound = (server: McpServer, credential_id: string | null): McpServerBinding => ({
	name: server.name,
	url: server.url,
	credential_id,
	...(server.permissions === undefined ? {} : { permissions: server.permissions }),
})

/**
 * Decides which credential each of an agent's MCP servers uses in one session.
 * A server named in `explicit` uses that credential, which must be stored for
 * the server's URL. Otherwise the credentials offered by the session's vaults
 * decide: one stored for the URL is used, none leaves the server
 * unauthenticated, and more than one is refused rather than picked from.
 */
export const resolveMcpServerBindings = (input: {
	readonly servers: ReadonlyArray<McpServer>
	readonly explicit: ReadonlyArray<ExplicitBinding>
	readonly offered: ReadonlyArray<StoredCredential>
}): BindingResolution => {
	const bindings: Array<McpServerBinding> = []
	for (const [index, binding] of input.explicit.entries()) {
		if (!input.servers.some((server) => server.name === binding.mcp_server_name)) {
			return refuse(
				`mcp_server_credentials names "${binding.mcp_server_name}", which is not one of the agent's MCP servers.`,
			)
		}
		if (
			input.explicit.findIndex((other) => other.mcp_server_name === binding.mcp_server_name) !==
			index
		) {
			return refuse(`MCP server "${binding.mcp_server_name}" is bound more than once.`)
		}
	}
	for (const server of input.servers) {
		const explicit = input.explicit.find((binding) => binding.mcp_server_name === server.name)
		if (explicit !== undefined) {
			if (explicit.mcp_server_url === null) {
				return refuse(`Credential ${explicit.credential_id} is not an active credential.`)
			}
			if (explicit.mcp_server_url !== server.url) {
				return refuse(
					`Credential ${explicit.credential_id} is stored for ${explicit.mcp_server_url}, not for MCP server "${server.name}" (${server.url}).`,
				)
			}
			bindings.push(bound(server, explicit.credential_id))
			continue
		}
		const matches = [
			...new Set(
				input.offered
					.filter((credential) => credential.mcp_server_url === server.url)
					.map((credential) => credential.credential_id),
			),
		]
		if (matches.length > 1) {
			return refuse(
				`MCP server "${server.name}" matches more than one credential in vault_ids (${matches.join(", ")}). Bind one with mcp_server_credentials.`,
			)
		}
		bindings.push(bound(server, matches[0] ?? null))
	}
	return { ok: true, bindings }
}

/**
 * The servers a `limited` environment does not let a session reach: those
 * whose host is not listed, unless the environment allows every MCP server.
 */
export const mcpServersOutsideNetwork = (
	servers: ReadonlyArray<McpServer>,
	networking:
		| { readonly type: "unrestricted" }
		| {
				readonly type: "limited"
				readonly allow_mcp_servers: boolean
				readonly allowed_hosts: ReadonlyArray<string>
		  },
): ReadonlyArray<McpServer> => {
	if (networking.type === "unrestricted" || networking.allow_mcp_servers) {
		return []
	}
	const allowed = new Set(networking.allowed_hosts.map((host) => host.toLowerCase()))
	return servers.filter((server) => !allowed.has(new URL(server.url).hostname.toLowerCase()))
}

export type Networking = Parameters<typeof mcpServersOutsideNetwork>[1]

export type SessionServersBinding =
	| { readonly ok: true; readonly mcpServers: string }
	| { readonly ok: false; readonly message: string }

/**
 * The one step that binds a new session's servers, whatever admits it: the
 * credentials it may use, the environment's network rules, and the size the
 * recorded binding may take. A session created without vaults passes none.
 */
export const bindSessionServers = (input: {
	readonly servers: ReadonlyArray<McpServer>
	readonly explicit: ReadonlyArray<ExplicitBinding>
	readonly offered: ReadonlyArray<StoredCredential>
	readonly networking: Networking | null
}): SessionServersBinding => {
	const resolved = resolveMcpServerBindings(input)
	if (!resolved.ok) {
		return resolved
	}
	const blocked =
		input.networking === null ? [] : mcpServersOutsideNetwork(input.servers, input.networking)
	if (blocked.length > 0) {
		return {
			ok: false,
			message: `The environment's networking does not allow MCP server ${blocked
				.map((server) => `"${server.name}" (${new URL(server.url).hostname})`)
				.join(", ")}. Add the host to allowed_hosts or set allow_mcp_servers.`,
		}
	}
	const mcpServers = McpServerBindingList.encode(resolved.bindings)
	if (mcpServers.length > MAX_MCP_SERVERS_TEXT_LENGTH) {
		return {
			ok: false,
			message: `The session's MCP server bindings take ${mcpServers.length} characters; at most ${MAX_MCP_SERVERS_TEXT_LENGTH} fit.`,
		}
	}
	return { ok: true, mcpServers }
}
