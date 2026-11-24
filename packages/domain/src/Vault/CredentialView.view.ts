import * as Domain from "@alchemy.run/domain"
import { CredentialSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { Credential } from "./Credential.aggregate.ts"

export { CredentialSnapshot }

export class CredentialView extends Domain.View("CredentialView", {
	version: 1,
	from: [Credential],
	key: Credential,
	state: Schema.NullOr(CredentialSnapshot),
	initial: null,
	evolve: {
		"vault_credential.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "vault_credential" as const,
						vault_id: e.vault_id,
						auth: e.auth,
						display_name: e.display_name,
						refresh_failed_at: null,
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"vault_credential.renamed": (state, e, ctx) =>
			state === null ? null : { ...state, display_name: e.display_name, updated_at: ctx.at },
		"vault_credential.rotated": (state, e, ctx) =>
			state === null
				? null
				: {
						...state,
						auth:
							state.auth.type === "mcp_oauth"
								? { ...state.auth, expires_at: e.expires_at }
								: state.auth,
						refresh_failed_at: null,
						updated_at: ctx.at,
					},
		"vault_credential.refreshed": (state, e, ctx) =>
			state === null || state.auth.type !== "mcp_oauth"
				? state
				: {
						...state,
						auth: { ...state.auth, expires_at: e.expires_at },
						refresh_failed_at: null,
						updated_at: ctx.at,
					},
		"vault_credential.refresh_failed": (state, _e, ctx) =>
			state === null || state.refresh_failed_at !== null
				? state
				: { ...state, refresh_failed_at: ctx.at, updated_at: ctx.at },
		"vault_credential.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: { ...state, archived_at: ctx.at, updated_at: ctx.at },
		"vault_credential.deleted": () => null,
	},
}) {}
