import { ApiServerBindingList } from "@checkfu/domain/Mcp/ApiServers"
import type { ApiServer, ApiServerBinding } from "@checkfu/domain/Mcp/ApiServers"
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

interface Refusal {
	readonly ok: false
	readonly message: string
}

const refuse = (message: string): Refusal => ({ ok: false, message })

interface ServerKind {
	/** What a server of this kind is called in a refusal. */
	readonly label: string
	/** The session field that binds one explicitly. */
	readonly field: string
}

/**
 * Decides which credential each of an agent's servers uses in one session.
 * A server named in `explicit` uses that credential, which must be stored for
 * the server's URL. Otherwise the credentials offered by the session's vaults
 * decide: one stored for the URL is used, none leaves the server
 * unauthenticated, and more than one is refused rather than picked from.
 */
const resolve = <Server extends { readonly name: string }>(
	kind: ServerKind,
	urlOf: (server: Server) => string,
	input: {
		readonly servers: ReadonlyArray<Server>
		readonly explicit: ReadonlyArray<{
			readonly name: string
			readonly credential_id: string
			readonly url: string | null
		}>
		readonly offered: ReadonlyArray<{ readonly credential_id: string; readonly url: string }>
	},
):
	| {
			readonly ok: true
			readonly bound: ReadonlyArray<{
				readonly server: Server
				readonly credential_id: string | null
			}>
	  }
	| Refusal => {
	const bound: Array<{ readonly server: Server; readonly credential_id: string | null }> = []
	for (const [index, binding] of input.explicit.entries()) {
		if (!input.servers.some((server) => server.name === binding.name)) {
			return refuse(
				`${kind.field} names "${binding.name}", which is not one of the agent's ${kind.label}s.`,
			)
		}
		if (input.explicit.findIndex((other) => other.name === binding.name) !== index) {
			return refuse(`${kind.label} "${binding.name}" is bound more than once.`)
		}
	}
	for (const server of input.servers) {
		const url = urlOf(server)
		const explicit = input.explicit.find((binding) => binding.name === server.name)
		if (explicit !== undefined) {
			if (explicit.url === null) {
				return refuse(
					`Credential ${explicit.credential_id} is not an active credential an ${kind.label} can use.`,
				)
			}
			if (explicit.url !== url) {
				return refuse(
					`Credential ${explicit.credential_id} is stored for ${explicit.url}, not for ${kind.label} "${server.name}" (${url}).`,
				)
			}
			bound.push({ server, credential_id: explicit.credential_id })
			continue
		}
		const matches = [
			...new Set(
				input.offered
					.filter((credential) => credential.url === url)
					.map((credential) => credential.credential_id),
			),
		]
		if (matches.length > 1) {
			return refuse(
				`${kind.label} "${server.name}" matches more than one credential in vault_ids (${matches.join(", ")}). Bind one with ${kind.field}.`,
			)
		}
		bound.push({ server, credential_id: matches[0] ?? null })
	}
	return { ok: true, bound }
}

/** `offered` and `explicit` hold only credentials an MCP server can use: bearer tokens and OAuth grants. */
export const resolveMcpServerBindings = (input: {
	readonly servers: ReadonlyArray<McpServer>
	readonly explicit: ReadonlyArray<ExplicitBinding>
	readonly offered: ReadonlyArray<StoredCredential>
}): BindingResolution => {
	const resolved = resolve(
		{ label: "MCP server", field: "mcp_server_credentials" },
		(server) => server.url,
		{
			servers: input.servers,
			explicit: input.explicit.map((binding) => ({
				name: binding.mcp_server_name,
				credential_id: binding.credential_id,
				url: binding.mcp_server_url,
			})),
			offered: input.offered.map((credential) => ({
				credential_id: credential.credential_id,
				url: credential.mcp_server_url,
			})),
		},
	)
	return resolved.ok
		? {
				ok: true,
				// A session keeps the agent's policy for each server, as it was when the session began.
				bindings: resolved.bound.map(({ server, credential_id }) => ({
					name: server.name,
					url: server.url,
					credential_id,
					...(server.permissions === undefined ? {} : { permissions: server.permissions }),
				})),
			}
		: resolved
}

/** As for MCP servers, by base URL. `offered` and `explicit` hold only API key credentials. */
export const resolveApiServerBindings = (input: {
	readonly servers: ReadonlyArray<ApiServer>
	readonly explicit: ReadonlyArray<{
		readonly api_server_name: string
		readonly credential_id: string
		readonly base_url: string | null
	}>
	readonly offered: ReadonlyArray<{ readonly credential_id: string; readonly base_url: string }>
}):
	| { readonly ok: true; readonly bindings: ReadonlyArray<ApiServerBinding> }
	| { readonly ok: false; readonly message: string } => {
	const resolved = resolve(
		{ label: "API server", field: "api_server_credentials" },
		(server) => server.base_url,
		{
			servers: input.servers,
			explicit: input.explicit.map((binding) => ({
				name: binding.api_server_name,
				credential_id: binding.credential_id,
				url: binding.base_url,
			})),
			offered: input.offered.map((credential) => ({
				credential_id: credential.credential_id,
				url: credential.base_url,
			})),
		},
	)
	return resolved.ok
		? {
				ok: true,
				bindings: resolved.bound.map(({ server, credential_id }) => ({
					name: server.name,
					base_url: server.base_url,
					catalog_id: server.catalog_id,
					credential_id,
					...(server.permissions === undefined ? {} : { permissions: server.permissions }),
				})),
			}
		: resolved
}

export type Networking =
	| { readonly type: "unrestricted" }
	| {
			readonly type: "limited"
			readonly allow_mcp_servers: boolean
			readonly allowed_hosts: ReadonlyArray<string>
	  }

const outsideHosts = <Server>(
	servers: ReadonlyArray<Server>,
	urlOf: (server: Server) => string,
	allowedHosts: ReadonlyArray<string>,
): ReadonlyArray<Server> => {
	const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()))
	return servers.filter((server) => !allowed.has(new URL(urlOf(server)).hostname.toLowerCase()))
}

/**
 * The servers a `limited` environment does not let a session reach: those
 * whose host is not listed, unless the environment allows every MCP server.
 */
export const mcpServersOutsideNetwork = (
	servers: ReadonlyArray<McpServer>,
	networking: Networking,
): ReadonlyArray<McpServer> =>
	networking.type === "unrestricted" || networking.allow_mcp_servers
		? []
		: outsideHosts(servers, (server) => server.url, networking.allowed_hosts)

/** The API servers a `limited` environment does not let a session reach: those whose host is not listed. */
export const apiServersOutsideNetwork = (
	servers: ReadonlyArray<ApiServer>,
	networking: Networking,
): ReadonlyArray<ApiServer> =>
	networking.type === "unrestricted"
		? []
		: outsideHosts(servers, (server) => server.base_url, networking.allowed_hosts)

export type SessionServersBinding =
	| { readonly ok: true; readonly mcpServers: string; readonly apiServers: string }
	| { readonly ok: false; readonly message: string }

const tooLarge = (kind: string, text: string) =>
	text.length > MAX_MCP_SERVERS_TEXT_LENGTH
		? `The session's ${kind} bindings take ${text.length} characters; at most ${MAX_MCP_SERVERS_TEXT_LENGTH} fit.`
		: undefined

/**
 * The one step that binds a new session's servers, whatever admits it: the
 * credentials each may use, the environment's network rules, and the size the
 * recorded bindings may take. A session created without vaults passes none.
 */
export const bindSessionServers = (input: {
	readonly servers: ReadonlyArray<McpServer>
	readonly explicit: ReadonlyArray<ExplicitBinding>
	readonly offered: ReadonlyArray<StoredCredential>
	readonly apiServers: ReadonlyArray<ApiServer>
	readonly explicitApis: Parameters<typeof resolveApiServerBindings>[0]["explicit"]
	readonly offeredApis: Parameters<typeof resolveApiServerBindings>[0]["offered"]
	readonly networking: Networking | null
}): SessionServersBinding => {
	const resolved = resolveMcpServerBindings(input)
	if (!resolved.ok) {
		return resolved
	}
	const resolvedApis = resolveApiServerBindings({
		servers: input.apiServers,
		explicit: input.explicitApis,
		offered: input.offeredApis,
	})
	if (!resolvedApis.ok) {
		return resolvedApis
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
	const blockedApis =
		input.networking === null ? [] : apiServersOutsideNetwork(input.apiServers, input.networking)
	if (blockedApis.length > 0) {
		return {
			ok: false,
			message: `The environment's networking does not allow API server ${blockedApis
				.map((server) => `"${server.name}" (${new URL(server.base_url).hostname})`)
				.join(", ")}. Add the host to allowed_hosts.`,
		}
	}
	const mcpServers = McpServerBindingList.encode(resolved.bindings)
	const apiServers = ApiServerBindingList.encode(resolvedApis.bindings)
	const refused = tooLarge("MCP server", mcpServers) ?? tooLarge("API server", apiServers)
	return refused === undefined
		? { ok: true, mcpServers, apiServers }
		: { ok: false, message: refused }
}
