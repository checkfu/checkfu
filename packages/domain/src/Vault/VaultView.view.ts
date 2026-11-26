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
						custody: { storing: 0, held: 0, erasing: 0 },
						created_at: ctx.at,
						updated_at: ctx.at,
						archived_at: null,
					},
		"vault.renamed": (state, e, ctx) =>
			state === null ? null : { ...state, display_name: e.display_name, updated_at: ctx.at },
		"vault.credential_attached": (state) =>
			state === null || state.archived_at
				? state
				: { ...state, custody: { ...state.custody, storing: state.custody.storing + 1 } },
		"vault.credential_storage_counted": (state) =>
			state === null || state.archived_at || state.custody.storing === 0
				? state
				: {
						...state,
						custody: {
							...state.custody,
							storing: state.custody.storing - 1,
							held: state.custody.held + 1,
						},
					},
		"vault.credential_detached": (state, e) => {
			if (state === null || state.archived_at) {
				return state
			}
			const { storing, held, erasing } = state.custody
			if (e.custody === "storing") {
				return storing === 0
					? state
					: { ...state, custody: { storing: storing - 1, held, erasing: erasing + 1 } }
			}
			return held === 0
				? state
				: { ...state, custody: { storing, held: held - 1, erasing: erasing + 1 } }
		},
		"vault.credential_erasure_counted": (state) =>
			state === null || state.custody.erasing === 0
				? state
				: { ...state, custody: { ...state.custody, erasing: state.custody.erasing - 1 } },
		"vault.archived": (state, _e, ctx) =>
			state === null || state.archived_at
				? state
				: {
						...state,
						custody: {
							storing: 0,
							held: 0,
							erasing: state.custody.erasing + state.custody.held + state.custody.storing,
						},
						archived_at: ctx.at,
						updated_at: ctx.at,
					},
		"vault.deleted": () => null,
	},
}) {}
