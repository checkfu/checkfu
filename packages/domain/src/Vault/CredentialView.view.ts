import * as Domain from "@alchemy.run/domain"
import { CredentialSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { Credential } from "./Credential.aggregate.ts"

export { CredentialSnapshot }

export class CredentialView extends Domain.View("CredentialView", {
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
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"vault_credential.renamed": (state, e, ctx) =>
			state === null ? null : { ...state, display_name: e.display_name, updated_at: ctx.at },
		"vault_credential.rotated": (state, _e, ctx) =>
			state === null ? null : { ...state, updated_at: ctx.at },
		"vault_credential.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: { ...state, archived_at: ctx.at, updated_at: ctx.at },
		"vault_credential.deleted": () => null,
	},
}) {}
