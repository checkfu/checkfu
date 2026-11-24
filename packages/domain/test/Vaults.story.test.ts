import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import {
	ArchiveCredential,
	CredentialArchived,
	CredentialDetached,
} from "../src/Vault/ArchiveCredential.command.ts"
import {
	ArchiveVault,
	CredentialReleased,
	VaultArchived,
} from "../src/Vault/ArchiveVault.command.ts"
import {
	CreateCredential,
	CredentialAlreadyExists,
	CredentialAttached,
	CredentialCreated,
	CredentialLimitReached,
	CredentialUrlConflict,
} from "../src/Vault/CreateCredential.command.ts"
import { CreateVault, VaultAlreadyExists, VaultCreated } from "../src/Vault/CreateVault.command.ts"
import { Credential } from "../src/Vault/Credential.aggregate.ts"
import { CredentialArchivedError } from "../src/Vault/CredentialArchived.rejection.ts"
import { CredentialNotFound } from "../src/Vault/CredentialNotFound.rejection.ts"
import { CredentialSecrets } from "../src/Vault/CredentialSecrets.external.ts"
import { CredentialView } from "../src/Vault/CredentialView.view.ts"
import { CredentialDeleted, DeleteCredential } from "../src/Vault/DeleteCredential.command.ts"
import { DeleteVault, VaultDeleted } from "../src/Vault/DeleteVault.command.ts"
import { RetireCredential } from "../src/Vault/RetireCredential.command.ts"
import { CredentialRotated, RotateCredential } from "../src/Vault/RotateCredential.command.ts"
import { CredentialRenamed, UpdateCredential } from "../src/Vault/UpdateCredential.command.ts"
import { UpdateVault, VaultRenamed } from "../src/Vault/UpdateVault.command.ts"
import { Vault } from "../src/Vault/Vault.aggregate.ts"
import { VaultArchivedError } from "../src/Vault/VaultArchived.rejection.ts"
import { VaultNotFound } from "../src/Vault/VaultNotFound.rejection.ts"
import { RetireReleasedCredentialLive } from "../src/Vault/RetireReleasedCredential.policy.ts"
import {
	SettleCredentialSecret,
	SettleCredentialSecretLive,
} from "../src/Vault/SettleCredentialSecret.policy.ts"
import { MAX_VAULT_CREDENTIALS } from "../src/Vault/VaultTypes.ts"
import { VaultView } from "../src/Vault/VaultView.view.ts"
import { Vaults, VaultsHandlersLive } from "../src/Vaults.model.ts"

const story = Story.make(Vaults, {
	layer: VaultsHandlersLive,
	stub: [CredentialSecrets],
})

// The hosted inbox delivers a failed row again. Story's in-memory host surfaces a
// failed policy at once, so ask for one redelivery here.
const redeliveryStory = Story.make(Vaults, {
	layer: Layer.mergeAll(
		RetireReleasedCredentialLive,
		SettleCredentialSecret.toLayer(SettleCredentialSecret, { retry: Schedule.recurs(1) }).pipe(
			Layer.provide(SettleCredentialSecretLive),
		),
	),
	stub: [CredentialSecrets],
})

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")

const bearer = (mcp_server_url: string) => ({ type: "static_bearer" as const, mcp_server_url })
const GITHUB = bearer("https://mcp.github.example/mcp")
const LINEAR = bearer("https://mcp.linear.example/mcp")

const vault = Vault.ref("vlt_001")
const credential = Credential.ref("vcrd_001")

const created = Story.given(vault, new VaultCreated({ display_name: "Alice" }))

const holding = (ref: typeof credential, auth: typeof GITHUB) => [
	Story.given(vault, new CredentialAttached({ credential_id: ref.id, auth })),
	Story.given(ref, new CredentialCreated({ vault_id: vault.id, auth, display_name: null })),
]

const kept = (ref: typeof credential) => [
	Story.call(CredentialSecrets.keep, { credential_id: ref.id }),
	Story.succeed(CredentialSecrets.keep, undefined),
]

const erased = (ref: typeof credential) => [
	Story.call(CredentialSecrets.erase, { credential_id: ref.id }),
	Story.succeed(CredentialSecrets.erase, undefined),
]

describe("Vaults", () => {
	it.effect("is well defined", () =>
		Effect.scoped(
			Layer.build(
				Vaults.layer(
					VaultsHandlersLive.pipe(
						Layer.provide(
							CredentialSecrets.toLayer(
								Effect.succeed({
									store: () => Effect.succeed({ stored: true }),
									replace: () => Effect.succeed({ replaced: true }),
									keep: () => Effect.void,
									erase: () => Effect.void,
								}),
							),
						),
					),
				),
			),
		).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect("creates, renames, archives and deletes a vault", () =>
		story(
			Story.clock(t0),
			Story.when(new CreateVault({ vault_id: vault.id, display_name: "Alice" })),
			Story.then(vault, new VaultCreated({ display_name: "Alice" })),
			Story.view(VaultView, vault, {
				id: vault.id,
				type: "vault",
				display_name: "Alice",
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
			Story.when(new CreateVault({ vault_id: vault.id, display_name: "Again" })),
			Story.rejected(new VaultAlreadyExists({ vault_id: vault.id })),
			Story.clock(t1),
			Story.when(new UpdateVault({ vault_id: vault.id, changes: {} })),
			Story.then(vault),
			Story.when(new UpdateVault({ vault_id: vault.id, changes: { display_name: "Alice B" } })),
			Story.then(vault, new VaultRenamed({ display_name: "Alice B" })),
			Story.view(VaultView, vault, { display_name: "Alice B", created_at: t0, updated_at: t1 }),
			Story.clock(t2),
			Story.when(new ArchiveVault({ vault_id: vault.id })),
			Story.then(vault, new VaultArchived()),
			Story.view(VaultView, vault, { archived_at: t2, updated_at: t2 }),
			Story.when(new ArchiveVault({ vault_id: vault.id })),
			Story.then(vault),
			Story.when(new UpdateVault({ vault_id: vault.id, changes: { display_name: "Late" } })),
			Story.rejected(new VaultArchivedError({ vault_id: vault.id })),
			Story.when(new DeleteVault({ vault_id: vault.id })),
			Story.then(vault, new VaultDeleted()),
			Story.view(VaultView, vault, Story.none),
			Story.state(vault, { status: "deleted", credentials: [] }),
			Story.when(new DeleteVault({ vault_id: vault.id })),
			Story.rejected(new VaultNotFound({ vault_id: vault.id })),
			Story.when(new ArchiveVault({ vault_id: vault.id })),
			Story.rejected(new VaultNotFound({ vault_id: vault.id })),
			Story.when(new UpdateVault({ vault_id: vault.id, changes: { display_name: "Gone" } })),
			Story.rejected(new VaultNotFound({ vault_id: vault.id })),
		),
	)

	it.effect("stores a credential in a vault and confirms its secret is to be kept", () =>
		story(
			created,
			Story.clock(t0),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					auth: GITHUB,
					display_name: "GitHub (work)",
				}),
			),
			Story.then(vault, new CredentialAttached({ credential_id: credential.id, auth: GITHUB })),
			Story.then(
				credential,
				new CredentialCreated({ vault_id: vault.id, auth: GITHUB, display_name: "GitHub (work)" }),
			),
			...kept(credential),
			Story.state(vault, {
				credentials: [{ credential_id: credential.id, mcp_server_url: GITHUB.mcp_server_url }],
			}),
			Story.state(credential, { status: "active", vault_id: vault.id }),
			Story.view(CredentialView, credential, {
				id: credential.id,
				type: "vault_credential",
				vault_id: vault.id,
				auth: GITHUB,
				display_name: "GitHub (work)",
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
		),
	)

	it.effect("refuses a credential for a vault that is missing, archived or deleted", () => {
		const attempt = new CreateCredential({
			vault_id: vault.id,
			credential_id: credential.id,
			auth: GITHUB,
			display_name: null,
		})
		return story(
			Story.when(attempt),
			Story.rejected(new VaultNotFound({ vault_id: vault.id })),
			created,
			Story.given(vault, new VaultArchived()),
			Story.when(attempt),
			Story.rejected(new VaultArchivedError({ vault_id: vault.id })),
			Story.given(vault, new VaultDeleted()),
			Story.when(attempt),
			Story.rejected(new VaultNotFound({ vault_id: vault.id })),
			Story.then(credential),
		)
	})

	it.effect("refuses a second active credential for the same MCP server URL", () => {
		const second = Credential.ref("vcrd_002")
		return story(
			created,
			...holding(credential, GITHUB),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: second.id,
					auth: GITHUB,
					display_name: null,
				}),
			),
			Story.rejected(
				new CredentialUrlConflict({
					vault_id: vault.id,
					credential_id: credential.id,
					mcp_server_url: GITHUB.mcp_server_url,
				}),
			),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					auth: LINEAR,
					display_name: null,
				}),
			),
			Story.rejected(new CredentialAlreadyExists({ credential_id: credential.id })),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: second.id,
					auth: LINEAR,
					display_name: null,
				}),
			),
			Story.then(vault, new CredentialAttached({ credential_id: second.id, auth: LINEAR })),
			Story.then(
				second,
				new CredentialCreated({ vault_id: vault.id, auth: LINEAR, display_name: null }),
			),
			...kept(second),
		)
	})

	it.effect(
		"holds no more credentials than the limit, and takes one again once a slot frees",
		() => {
			const held = Array.from({ length: MAX_VAULT_CREDENTIALS }, (_, index) => ({
				ref: Credential.ref(`vcrd_full_${index}`),
				auth: bearer(`https://mcp-${index}.example/mcp`),
			}))
			const extra = Credential.ref("vcrd_extra")
			const attempt = new CreateCredential({
				vault_id: vault.id,
				credential_id: extra.id,
				auth: GITHUB,
				display_name: null,
			})
			const first = held[0]
			if (first === undefined) {
				return Effect.die("the limit is at least one")
			}
			return story(
				created,
				...held.flatMap(({ ref, auth }) => holding(ref, auth)),
				Story.when(attempt),
				Story.rejected(
					new CredentialLimitReached({ vault_id: vault.id, limit: MAX_VAULT_CREDENTIALS }),
				),
				Story.when(new ArchiveCredential({ vault_id: vault.id, credential_id: first.ref.id })),
				Story.then(vault, new CredentialDetached({ credential_id: first.ref.id })),
				Story.then(first.ref, new CredentialArchived()),
				...erased(first.ref),
				Story.when(attempt),
				Story.then(vault, new CredentialAttached({ credential_id: extra.id, auth: GITHUB })),
				Story.then(
					extra,
					new CredentialCreated({ vault_id: vault.id, auth: GITHUB, display_name: null }),
				),
				...kept(extra),
			)
		},
	)

	it.effect("renames and rotates a credential without recording its secret", () =>
		story(
			created,
			Story.clock(t0),
			...holding(credential, GITHUB),
			Story.clock(t1),
			Story.when(
				new UpdateCredential({ vault_id: vault.id, credential_id: credential.id, changes: {} }),
			),
			Story.then(credential),
			Story.when(
				new UpdateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					changes: { display_name: "Renamed" },
				}),
			),
			Story.then(credential, new CredentialRenamed({ display_name: "Renamed" })),
			Story.view(CredentialView, credential, {
				display_name: "Renamed",
				created_at: t0,
				updated_at: t1,
			}),
			Story.clock(t2),
			Story.when(new RotateCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(credential, new CredentialRotated()),
			Story.view(CredentialView, credential, { display_name: "Renamed", updated_at: t2 }),
			Story.when(
				new UpdateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					changes: { display_name: null },
				}),
			),
			Story.then(credential, new CredentialRenamed({ display_name: null })),
		),
	)

	it.effect("archives a credential once, frees its URL, and erases its secret", () => {
		const replacement = Credential.ref("vcrd_002")
		return story(
			created,
			Story.clock(t0),
			...holding(credential, GITHUB),
			Story.clock(t1),
			Story.when(new ArchiveCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(vault, new CredentialDetached({ credential_id: credential.id })),
			Story.then(credential, new CredentialArchived()),
			...erased(credential),
			Story.state(vault, { credentials: [] }),
			Story.view(CredentialView, credential, { archived_at: t1, updated_at: t1 }),
			Story.when(new ArchiveCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(vault),
			Story.then(credential),
			Story.when(new RotateCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.rejected(new CredentialArchivedError({ credential_id: credential.id })),
			Story.when(
				new UpdateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					changes: { display_name: "Late" },
				}),
			),
			Story.rejected(new CredentialArchivedError({ credential_id: credential.id })),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: replacement.id,
					auth: GITHUB,
					display_name: null,
				}),
			),
			Story.then(vault, new CredentialAttached({ credential_id: replacement.id, auth: GITHUB })),
			Story.then(
				replacement,
				new CredentialCreated({ vault_id: vault.id, auth: GITHUB, display_name: null }),
			),
			...kept(replacement),
		)
	})

	it.effect("deletes an active or an archived credential, and never brings its id back", () => {
		const archived = Credential.ref("vcrd_002")
		return story(
			created,
			...holding(credential, GITHUB),
			Story.given(
				archived,
				new CredentialCreated({ vault_id: vault.id, auth: LINEAR, display_name: null }),
			),
			Story.given(archived, new CredentialArchived()),
			Story.when(new DeleteCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(vault, new CredentialDetached({ credential_id: credential.id })),
			Story.then(credential, new CredentialDeleted()),
			...erased(credential),
			Story.view(CredentialView, credential, Story.none),
			Story.state(vault, { credentials: [] }),
			Story.when(new DeleteCredential({ vault_id: vault.id, credential_id: archived.id })),
			Story.then(vault, new CredentialDetached({ credential_id: archived.id })),
			Story.then(archived, new CredentialDeleted()),
			...erased(archived),
			Story.view(CredentialView, archived, Story.none),
			Story.when(new DeleteCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(new ArchiveCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(
				new CreateCredential({
					vault_id: vault.id,
					credential_id: credential.id,
					auth: GITHUB,
					display_name: null,
				}),
			),
			Story.rejected(new CredentialAlreadyExists({ credential_id: credential.id })),
		)
	})

	it.effect("lets no other vault touch a credential", () => {
		const other = Vault.ref("vlt_other")
		return story(
			created,
			Story.given(other, new VaultCreated({ display_name: "Mallory" })),
			...holding(credential, GITHUB),
			Story.when(new ArchiveCredential({ vault_id: other.id, credential_id: credential.id })),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(new DeleteCredential({ vault_id: other.id, credential_id: credential.id })),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(new RotateCredential({ vault_id: other.id, credential_id: credential.id })),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(
				new UpdateCredential({
					vault_id: other.id,
					credential_id: credential.id,
					changes: { display_name: "Stolen" },
				}),
			),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.given(other, new VaultDeleted()),
			Story.when(new RetireCredential({ vault_id: other.id, credential_id: credential.id })),
			Story.then(credential),
			Story.state(credential, { status: "active", vault_id: vault.id }),
			Story.state(vault, {
				credentials: [{ credential_id: credential.id, mcp_server_url: GITHUB.mcp_server_url }],
			}),
		)
	})

	it.effect("retires nothing while the vault is live", () =>
		story(
			created,
			...holding(credential, GITHUB),
			Story.when(new RetireCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(credential),
			Story.state(credential, { status: "active" }),
		),
	)

	it.effect("archives every credential of an archived vault and erases each secret", () => {
		const second = Credential.ref("vcrd_002")
		return story(
			created,
			Story.clock(t0),
			...holding(credential, GITHUB),
			...holding(second, LINEAR),
			Story.clock(t1),
			Story.when(new ArchiveVault({ vault_id: vault.id })),
			Story.then(
				vault,
				new CredentialReleased({ credential_id: credential.id }),
				new CredentialReleased({ credential_id: second.id }),
				new VaultArchived(),
			),
			Story.then(credential, new CredentialArchived()),
			Story.then(second, new CredentialArchived()),
			Story.call("first", CredentialSecrets.erase, { credential_id: credential.id }),
			Story.call("second", CredentialSecrets.erase, { credential_id: second.id }),
			Story.succeed("first", CredentialSecrets.erase, undefined),
			Story.succeed("second", CredentialSecrets.erase, undefined),
			Story.state(vault, { status: "archived", credentials: [] }),
			Story.view(VaultView, vault, { archived_at: t1 }),
			Story.view(CredentialView, credential, { archived_at: t1 }),
			Story.view(CredentialView, second, { archived_at: t1 }),
		)
	})

	it.effect(
		"deletes every credential of a deleted vault, asking custody again until it answers",
		() =>
			redeliveryStory(
				created,
				...holding(credential, GITHUB),
				Story.when(new DeleteVault({ vault_id: vault.id })),
				Story.then(
					vault,
					new CredentialReleased({ credential_id: credential.id }),
					new VaultDeleted(),
				),
				Story.then(credential, new CredentialDeleted()),
				Story.call(CredentialSecrets.erase, { credential_id: credential.id }),
				Story.die(CredentialSecrets.erase, new Error("custody unreachable")),
				...erased(credential),
				Story.view(VaultView, vault, Story.none),
				Story.view(CredentialView, credential, Story.none),
				Story.state(credential, { status: "deleted", vault_id: vault.id }),
			),
	)
})
