import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId } from "@checkfu/ui/format"
import { Select } from "@checkfu/ui/input"
import { Description, DescriptionList } from "@checkfu/ui/page-header"
import type { JsonAgent, JsonSession, JsonVault, JsonVaultCredential } from "@checkfu/sdk/client"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type * as React from "react"
import { credentialQuery, credentialsQuery, lookup, vaultQuery } from "../queries.ts"
import type { Lookup } from "../queries.ts"
import { reconcile } from "../selection.ts"

type Server = JsonAgent["mcp_servers"][number]

export interface ExplicitCredential {
	readonly credential_id: string
	readonly vault_id: string
}

export type ExplicitCredentials = Readonly<Record<string, ExplicitCredential>>

const spelling = (url: string): string | undefined => {
	if (!URL.canParse(url)) {
		return undefined
	}
	const parsed = new URL(url)
	parsed.hash = ""
	return parsed.href
}

export const isFor = (credential: JsonVaultCredential, server: Server): boolean => {
	const stored = spelling(credential.auth.mcp_server_url)
	return stored !== undefined && stored === spelling(server.url)
}

const usable = (credential: JsonVaultCredential): boolean => credential.custody === "held"

const activeOf = (vaults: ReadonlyArray<JsonVault>): ReadonlyArray<JsonVault> =>
	vaults.filter((vault) => vault.archived_at === null)

const choicesFor = (
	server: Server,
	credentials: ReadonlyArray<JsonVaultCredential>,
): ReadonlyArray<JsonVaultCredential> =>
	credentials.filter((credential) => isFor(credential, server))

export const goneSelections = (
	servers: ReadonlyArray<Server>,
	vaults: ReadonlyArray<JsonVault>,
	vaultIds: ReadonlyArray<string>,
	explicit: ExplicitCredentials,
	credentials: ReadonlyArray<JsonVaultCredential>,
) => ({
	vaults: reconcile(vaultIds, activeOf(vaults)).gone,
	servers: servers.flatMap((server) => {
		const id = explicit[server.name]?.credential_id
		return id !== undefined && reconcile([id], choicesFor(server, credentials)).gone.length > 0
			? [server.name]
			: []
	}),
})

const RANK = { gone: 0, failed: 1, pending: 2, active: 3 } as const

const withParent = <T,>(own: Lookup<T>, parent: Lookup<unknown>): Lookup<T> =>
	parent.state !== "active" && RANK[parent.state] < RANK[own.state] ? { state: parent.state } : own

export const useSessionChoices = (
	servers: ReadonlyArray<Server>,
	vaults: ReadonlyArray<JsonVault>,
	vaultIds: ReadonlyArray<string>,
	explicit: ExplicitCredentials,
) => {
	const queryClient = useQueryClient()
	const listed = useCredentials(vaultIds)
	const listedVaults = activeOf(vaults).filter((vault) => !listed.gone.includes(vault.id))
	const listedCredentials = listed.credentials
	const missing = goneSelections(servers, vaults, vaultIds, explicit, listedCredentials)
	const vaultChecks = useQueries({
		queries: missing.vaults.map((id) => ({ ...vaultQuery(id), retry: false })),
		combine: (results) =>
			results.map((result, index) => ({
				id: missing.vaults[index] ?? "",
				retry: () => void result.refetch(),
				...lookup(result, (vault) => vault.archived_at === null),
			})),
	})
	const wanted = servers.flatMap((server) => {
		const chosen = explicit[server.name]
		return chosen !== undefined && missing.servers.includes(server.name) ? [{ server, chosen }] : []
	})
	const parentIds = [...new Set(wanted.map(({ chosen }) => chosen.vault_id))]
	const parents = useQueries({
		queries: parentIds.map((id) => ({ ...vaultQuery(id), retry: false })),
		combine: (results) =>
			new Map(
				results.map((result, index) => [
					parentIds[index] ?? "",
					lookup(result, (vault) => vault.archived_at === null),
				]),
			),
	})
	const credentialChecks = useQueries({
		queries: wanted.map(({ chosen }) => ({
			...credentialQuery(chosen.vault_id, chosen.credential_id),
			retry: false,
		})),
		combine: (results) =>
			results.flatMap((result, index) => {
				const want = wanted[index]
				if (want === undefined) {
					return []
				}
				const { server, chosen } = want
				const parent = parents.get(chosen.vault_id) ?? { state: "pending" as const }
				const own = lookup(
					result,
					(credential) =>
						usable(credential) && credential.archived_at === null && isFor(credential, server),
				)
				return [
					{
						server: server.name,
						retry: () => {
							void result.refetch()
							void queryClient.refetchQueries({ queryKey: vaultQuery(chosen.vault_id).queryKey })
						},
						...withParent(own, parent),
					},
				]
			}),
	})
	return {
		vaults: [
			...listedVaults,
			...vaultChecks.flatMap((check) => (check.state === "active" ? [check.found] : [])),
		],
		credentials: [
			...listedCredentials,
			...credentialChecks.flatMap((check) => (check.state === "active" ? [check.found] : [])),
		],
		gone: {
			vaults: [
				...listed.gone,
				...vaultChecks.flatMap((check) =>
					check.state === "gone" && !listed.gone.includes(check.id) ? [check.id] : [],
				),
			],
			servers: credentialChecks.flatMap((check) => (check.state === "gone" ? [check.server] : [])),
		},
		failed: {
			vaults: vaultChecks.filter((check) => check.state === "failed"),
			servers: credentialChecks.filter((check) => check.state === "failed"),
			lists: listed.failed,
		},
		checking:
			listed.pending ||
			[...vaultChecks, ...credentialChecks].some((check) => check.state === "pending"),
	}
}

type Choices = ReturnType<typeof useSessionChoices>

export const hasGoneSelection = (gone: Choices["gone"]): boolean =>
	gone.vaults.length > 0 || gone.servers.length > 0

export const hasFailedLookup = (failed: Choices["failed"]): boolean =>
	failed.vaults.length > 0 || failed.servers.length > 0 || failed.lists.length > 0

export const bindingsOf = (
	servers: ReadonlyArray<Server>,
	vaultIds: ReadonlyArray<string>,
	explicit: ExplicitCredentials,
	credentials: ReadonlyArray<JsonVaultCredential>,
) => {
	const named = servers.flatMap((server) => {
		const id = explicit[server.name]?.credential_id
		return id !== undefined && reconcile([id], choicesFor(server, credentials)).kept.length > 0
			? [{ mcp_server_name: server.name, credential_id: id }]
			: []
	})
	return {
		...(vaultIds.length === 0 ? {} : { vault_ids: [...vaultIds] }),
		...(named.length === 0 ? {} : { mcp_server_credentials: named }),
	}
}

const SERVER_IN_MESSAGE = /MCP server "([^"]+)"/u

export const placeError = (
	message: string | undefined,
	servers: ReadonlyArray<Server>,
): { readonly server: string | undefined; readonly message: string | undefined } => {
	const name = message === undefined ? undefined : SERVER_IN_MESSAGE.exec(message)?.[1]
	return servers.some((server) => server.name === name)
		? { server: name, message }
		: { server: undefined, message }
}

const isNetworkRefusal = (message: string): boolean => message.includes("network rules")

function ServerError({ message }: { readonly message: string }): React.JSX.Element {
	return (
		<Callout tone="error">
			{message}
			{isNetworkRefusal(message)
				? " Allow its host in the environment's networking, or choose another environment."
				: null}
		</Callout>
	)
}

const credentialLabel = (
	credential: {
		readonly id: string
		readonly vault_id: string
		readonly display_name: string | null
	},
	vaults: ReadonlyArray<JsonVault>,
): string =>
	[
		credential.display_name ?? "Credential",
		vaults.find((vault) => vault.id === credential.vault_id)?.display_name ??
			shortId(credential.vault_id),
		shortId(credential.id),
	].join(" · ")

export interface VaultList {
	readonly items: ReadonlyArray<JsonVault>
	readonly more: (() => void) | null
	readonly loading: boolean
	readonly error: string | undefined
	readonly moreError: string | undefined
	readonly retry: () => void
}

export function SessionCredentialFields({
	agent,
	vaultList,
	vaultIds,
	onVaults,
	explicit,
	onExplicit,
	error,
}: {
	readonly agent: JsonAgent | undefined
	readonly vaultList: VaultList
	readonly vaultIds: ReadonlyArray<string>
	readonly onVaults: (ids: ReadonlyArray<string>) => void
	readonly explicit: ExplicitCredentials
	readonly onExplicit: (explicit: ExplicitCredentials) => void
	readonly error: { readonly server: string | undefined; readonly message: string | undefined }
}): React.JSX.Element | null {
	const servers = agent?.mcp_servers ?? []
	const {
		vaults: active,
		credentials,
		gone,
		failed,
	} = useSessionChoices(servers, vaultList.items, vaultIds, explicit)
	const moreVaults = vaultList.more
	if (
		active.length === 0 &&
		servers.length === 0 &&
		gone.vaults.length === 0 &&
		failed.vaults.length === 0 &&
		failed.lists.length === 0
	) {
		return null
	}
	const removeVault = (id: string) => onVaults(vaultIds.filter((chosen) => chosen !== id))
	return (
		<>
			<fieldset className="space-y-2">
				<legend className="text-control font-medium">Vaults</legend>
				<p className="text-control text-muted-foreground">
					Each MCP server uses the one credential stored for its URL in these vaults.
				</p>
				{gone.vaults.map((id) => (
					<div key={id} className="flex items-center gap-2 text-control">
						<span className="text-destructive">
							Vault <span className="font-mono">{shortId(id)}</span> is no longer available.
						</span>
						<Button variant="ghost" size="sm" onClick={() => removeVault(id)}>
							Remove
						</Button>
					</div>
				))}
				{failed.vaults.map(({ id, retry }) => (
					<div key={id} className="flex items-center gap-2 text-control">
						<span className="text-destructive">
							Vault <span className="font-mono">{shortId(id)}</span> could not be checked.
						</span>
						<Button variant="ghost" size="sm" onClick={retry}>
							Retry
						</Button>
						<Button variant="ghost" size="sm" onClick={() => removeVault(id)}>
							Remove
						</Button>
					</div>
				))}
				{failed.lists.map(({ id, retry }) => (
					<div key={`list:${id}`} className="flex items-center gap-2 text-control">
						<span className="text-destructive">
							The credentials in vault <span className="font-mono">{shortId(id)}</span> could not be
							loaded.
						</span>
						<Button variant="ghost" size="sm" onClick={retry}>
							Retry
						</Button>
					</div>
				))}
				{vaultList.error === undefined ? null : (
					<div className="flex items-center gap-2 text-control">
						<span className="text-destructive">
							The vaults could not be loaded: {vaultList.error}
						</span>
						<Button variant="ghost" size="sm" onClick={vaultList.retry}>
							Retry
						</Button>
					</div>
				)}
				{vaultList.loading ? (
					<p className="text-control text-muted-foreground">Loading vaults…</p>
				) : active.length === 0 ? (
					vaultList.error === undefined ? (
						<p className="text-control text-muted-foreground">No active vaults.</p>
					) : null
				) : (
					active.map((vault) => (
						<label key={vault.id} className="flex items-center gap-2 text-control">
							<input
								type="checkbox"
								checked={vaultIds.includes(vault.id)}
								onChange={(event) =>
									onVaults(
										event.target.checked
											? [...vaultIds, vault.id]
											: vaultIds.filter((id) => id !== vault.id),
									)
								}
							/>
							{vault.display_name}
						</label>
					))
				)}
				{moreVaults === null ? null : vaultList.moreError === undefined ? (
					<Button variant="ghost" size="sm" onClick={moreVaults}>
						Load more vaults
					</Button>
				) : (
					<div className="flex items-center gap-2 text-control">
						<span className="text-destructive">
							More vaults could not be loaded: {vaultList.moreError}
						</span>
						<Button variant="ghost" size="sm" onClick={moreVaults}>
							Retry
						</Button>
					</div>
				)}
			</fieldset>
			{servers.map((server) => {
				const choices = choicesFor(server, credentials)
				const chosen = explicit[server.name]?.credential_id
				const unavailable = gone.servers.includes(server.name)
				const unchecked = failed.servers.find((check) => check.server === server.name)
				return (
					<div key={server.name} className="space-y-2">
						<Field
							label={`Credential for ${server.name}`}
							description={<span className="font-mono">{server.url}</span>}
						>
							<Select
								value={chosen ?? ""}
								onChange={(event) => {
									const { [server.name]: _, ...rest } = explicit
									const picked = choices.find((choice) => choice.id === event.target.value)
									onExplicit(
										picked === undefined
											? rest
											: {
													...rest,
													[server.name]: { credential_id: picked.id, vault_id: picked.vault_id },
												},
									)
								}}
							>
								<option value="">Match from the chosen vaults</option>
								{(unavailable || unchecked !== undefined) && chosen !== undefined ? (
									<option value={chosen} disabled>
										{unavailable ? "Unavailable credential" : "Credential"} {shortId(chosen)}
									</option>
								) : null}
								{choices.map((credential) => (
									<option key={credential.id} value={credential.id}>
										{credentialLabel(credential, vaultList.items)}
									</option>
								))}
							</Select>
						</Field>
						{unavailable ? (
							<Callout tone="error">
								The credential chosen for {server.name} is no longer available. Choose another, or
								match from the chosen vaults.
							</Callout>
						) : null}
						{unchecked === undefined ? null : (
							<Callout tone="error">
								<p>
									The credential chosen for {server.name} could not be checked. Try again, choose
									another, or match from the chosen vaults.
								</p>
								<Button variant="outline" size="sm" className="mt-2" onClick={unchecked.retry}>
									Retry
								</Button>
							</Callout>
						)}
						{error.server === server.name && error.message !== undefined ? (
							<ServerError message={error.message} />
						) : null}
					</div>
				)
			})}
		</>
	)
}

export const useCredentials = (vaultIds: ReadonlyArray<string>) =>
	useQueries({
		queries: vaultIds.map((id) => ({ ...credentialsQuery(id), retry: false })),
		combine: (results) => {
			const lists = results.map((result, index) => ({
				id: vaultIds[index] ?? "",
				retry: () => void result.refetch(),
				...lookup(result),
			}))
			return {
				credentials: lists
					.flatMap((list) => (list.state === "active" ? list.found.data : []))
					.filter((credential) => usable(credential)),
				gone: lists.flatMap((list) => (list.state === "gone" ? [list.id] : [])),
				failed: lists.filter((list) => list.state === "failed"),
				pending: lists.some((list) => list.state === "pending"),
			}
		},
	})

export function SessionBindings({
	session,
}: {
	readonly session: JsonSession
}): React.JSX.Element | null {
	if (session.mcp_server_credentials.length === 0) {
		return null
	}
	return (
		<DescriptionList>
			{session.mcp_server_credentials.map((pair) => (
				<Description key={pair.mcp_server_name} label={`MCP server ${pair.mcp_server_name}`}>
					<span className="font-mono text-xs">
						Credential {shortId(pair.credential_id)}
						{pair.vault_id === undefined ? null : (
							<>
								{" in "}
								<Link
									to="/vaults/$vaultId"
									params={{ vaultId: pair.vault_id }}
									className="hover:underline"
								>
									vault {shortId(pair.vault_id)}
								</Link>
							</>
						)}
					</span>
				</Description>
			))}
		</DescriptionList>
	)
}
