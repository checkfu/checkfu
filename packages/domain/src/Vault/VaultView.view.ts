import * as Domain from "@alchemy.run/domain"
import { VaultSnapshot } from "@checkfu/sdk/Schemas"
import * as Schema from "effect/Schema"
import { Vault } from "./Vault.aggregate.ts"

export { VaultSnapshot }

export class VaultView extends Domain.View("VaultView", {
	from: [Vault],
	key: Vault,
	state: Schema.NullOr(VaultSnapshot),
	initial: null,
	evolve: {
		"vault.created": (state, e, ctx) =>
			state !== null
				? state
				: {
						id: ctx.key.id,
						type: "vault" as const,
						display_name: e.display_name,
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"vault.renamed": (state, e, ctx) =>
			state === null ? null : { ...state, display_name: e.display_name, updated_at: ctx.at },
		"vault.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: { ...state, archived_at: ctx.at, updated_at: ctx.at },
		"vault.deleted": () => null,
	},
}) {}
