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
import { ArchiveVault, VaultArchived } from "../src/Vault/ArchiveVault.command.ts"
import {
	ConfirmCredentialErased,
	CredentialErasureCounted,
	CredentialSecretErased,
} from "../src/Vault/ConfirmCredentialErased.command.ts"
import {
	ConfirmCredentialStored,
	CredentialSecretStored,
	CredentialStorageCounted,
} from "../src/Vault/ConfirmCredentialStored.command.ts"
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
import { ListingStore } from "../src/Listing/ListingStore.ts"
import { CredentialSecrets } from "../src/Vault/CredentialSecrets.external.ts"
import {
	CredentialUrlClaim,
	CredentialUrlClaimed,
	CredentialUrlFreed,
	credentialUrlClaimId,
} from "../src/Vault/CredentialUrlClaim.aggregate.ts"
import { CredentialView } from "../src/Vault/CredentialView.view.ts"
import { CredentialDeleted, DeleteCredential } from "../src/Vault/DeleteCredential.command.ts"
import { DeleteVault, VaultDeleted } from "../src/Vault/DeleteVault.command.ts"
import { CredentialReleased, RetireCredential } from "../src/Vault/RetireCredential.command.ts"
import { CredentialRotated, RotateCredential } from "../src/Vault/RotateCredential.command.ts"
import { CredentialRenamed, UpdateCredential } from "../src/Vault/UpdateCredential.command.ts"
import { UpdateVault, VaultRenamed } from "../src/Vault/UpdateVault.command.ts"
import { Vault } from "../src/Vault/Vault.aggregate.ts"
import { VaultId } from "../src/Vault/Vault.id.ts"
import { VaultArchivedError } from "../src/Vault/VaultArchived.rejection.ts"
import { VaultNotFound } from "../src/Vault/VaultNotFound.rejection.ts"
import { RetireReleasedCredentialsLive } from "../src/Vault/RetireReleasedCredentials.policy.ts"
import {
	SettleCredentialSecret,
	SettleCredentialSecretLive,
} from "../src/Vault/SettleCredentialSecret.policy.ts"
import { MAX_VAULT_CREDENTIALS } from "../src/Vault/VaultTypes.ts"
import { VaultView } from "../src/Vault/VaultView.view.ts"
import { ListVaultsLive } from "../src/Vault/ListVaults.query.ts"
import { ListCredentialsLive } from "../src/Vault/ListCredentials.query.ts"
import { CredentialListingLive } from "../src/Vault/CredentialListing.projection.ts"
import { VaultListingLive } from "../src/Vault/VaultListing.projection.ts"
import { Vaults, VaultsHandlersLive } from "../src/Vaults.model.ts"

const story = Story.make(Vaults, {
	layer: VaultsHandlersLive.pipe(Layer.provide(ListingStore.memory)),
	stub: [CredentialSecrets],
})

const redeliveryStory = Story.make(Vaults, {
	layer: Layer.mergeAll(
		RetireReleasedCredentialsLive,
		SettleCredentialSecret.toLayer(SettleCredentialSecret, { retry: Schedule.recurs(1) }).pipe(
			Layer.provide(SettleCredentialSecretLive),
		),
		VaultListingLive,
		ListVaultsLive,
		CredentialListingLive,
		ListCredentialsLive,
	).pipe(Layer.provide(ListingStore.memory)),
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

const urlOf = (auth: typeof GITHUB) =>
	CredentialUrlClaim.ref(credentialUrlClaimId(vault.id, auth.mcp_server_url))

const holding = (ref: typeof credential, auth: typeof GITHUB, previous = "") => [
	Story.given(vault, new CredentialAttached({ credential_id: ref.id })),
	Story.given(
		ref,
		new CredentialCreated({ vault_id: vault.id, auth, display_name: null, previous }),
	),
	Story.given(urlOf(auth), new CredentialUrlClaimed({ credential_id: ref.id })),
	Story.given(ref, new CredentialSecretStored()),
	Story.given(vault, new CredentialStorageCounted({ credential_id: ref.id })),
]

const archive = (ref: typeof credential, auth: typeof GITHUB, vault_id = vault.id) =>
	new ArchiveCredential({
		vault_id,
		credential_id: ref.id,
		mcp_server_url: auth.mcp_server_url,
	})

const remove = (ref: typeof credential, auth: typeof GITHUB, vault_id = vault.id) =>
	new DeleteCredential({
		vault_id,
		credential_id: ref.id,
		mcp_server_url: auth.mcp_server_url,
	})

const sealed = [
	Story.call(CredentialSecrets.seal, { vault_id: vault.id }),
	Story.succeed(CredentialSecrets.seal, undefined),
]

const erased = (ref: typeof credential) => [
	Story.call(CredentialSecrets.erase, { vault_id: vault.id, credential_id: ref.id }),
	Story.succeed(CredentialSecrets.erase, undefined),
	Story.then(ref, new CredentialSecretErased()),
	Story.then(vault, new CredentialErasureCounted({ credential_id: ref.id })),
]

describe("Vaults", () => {
	it.effect("is well defined", () =>
		Effect.scoped(
			Layer.build(
				Vaults.layer(
					VaultsHandlersLive.pipe(
						Layer.provide(ListingStore.memory),
						Layer.provide(
							CredentialSecrets.toLayer(
								Effect.succeed({
									put: () => Effect.succeed({ refused: null }),
									erase: () => Effect.void,
									seal: () => Effect.void,
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
				custody: { storing: 0, held: 0, erasing: 0 },
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
			...sealed,
			Story.then(vault, new VaultArchived({ next: "" })),
			Story.view(VaultView, vault, { archived_at: t2, updated_at: t2 }),
			Story.when(new ArchiveVault({ vault_id: vault.id })),
			Story.then(vault),
			Story.when(new UpdateVault({ vault_id: vault.id, changes: { display_name: "Late" } })),
			Story.rejected(new VaultArchivedError({ vault_id: vault.id })),
			Story.when(new DeleteVault({ vault_id: vault.id })),
			...sealed,
			Story.then(vault, new VaultDeleted({ next: "" })),
			Story.view(VaultView, vault, Story.none),
			Story.state(vault, { status: "deleted", held: 0, erasing: 0, releasing: "" }),
			Story.when(new DeleteVault({ vault_id: vault.id })),
			Story.then(vault),
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
			Story.then(vault, new CredentialAttached({ credential_id: credential.id })),
			Story.then(
				credential,
				new CredentialCreated({
					vault_id: vault.id,
					auth: GITHUB,
					display_name: "GitHub (work)",
					previous: "",
				}),
			),
			Story.then(urlOf(GITHUB), new CredentialUrlClaimed({ credential_id: credential.id })),
			Story.state(vault, {
				storing: 1,
				held: 0,
				erasing: 0,
				last_attached: credential.id,
				releasing: "",
			}),
			Story.state(credential, {
				status: "active",
				vault_id: vault.id,
				mcp_server_url: GITHUB.mcp_server_url,
				previous: "",
				custody: "storing",
			}),
			Story.view(VaultView, vault, { custody: { storing: 1, held: 0, erasing: 0 } }),
			Story.view(CredentialView, credential, {
				id: credential.id,
				type: "vault_credential",
				vault_id: vault.id,
				auth: GITHUB,
				display_name: "GitHub (work)",
				custody: "storing",
				created_at: t0,
				updated_at: t0,
				archived_at: null,
			}),
			Story.when(new ConfirmCredentialStored({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(credential, new CredentialSecretStored()),
			Story.then(vault, new CredentialStorageCounted({ credential_id: credential.id })),
			Story.state(vault, { storing: 0, held: 1, erasing: 0 }),
			Story.state(credential, { custody: "held" }),
			Story.view(VaultView, vault, { custody: { storing: 0, held: 1, erasing: 0 } }),
			Story.view(CredentialView, credential, { custody: "held" }),
			Story.when(new ConfirmCredentialStored({ vault_id: vault.id, credential_id: credential.id })),
			Story.state(vault, { storing: 0, held: 1, erasing: 0 }),
		),
	)

	it.effect("archives a credential whose secret was never confirmed stored", () =>
		story(
			created,
			Story.given(vault, new CredentialAttached({ credential_id: credential.id })),
			Story.given(
				credential,
				new CredentialCreated({
					vault_id: vault.id,
					auth: GITHUB,
					display_name: null,
					previous: "",
				}),
			),
			Story.given(urlOf(GITHUB), new CredentialUrlClaimed({ credential_id: credential.id })),
			Story.when(archive(credential, GITHUB)),
			Story.then(
				vault,
				new CredentialDetached({ credential_id: credential.id, custody: "storing" }),
			),
			Story.then(credential, new CredentialArchived({ vault_id: vault.id })),
			Story.then(urlOf(GITHUB), new CredentialUrlFreed()),
			...erased(credential),
			Story.state(vault, { storing: 0, held: 0, erasing: 0 }),
			Story.state(credential, { status: "archived", custody: "erased" }),
			Story.when(new ConfirmCredentialStored({ vault_id: vault.id, credential_id: credential.id })),
			Story.state(credential, { custody: "erased" }),
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
			Story.given(vault, new VaultArchived({ next: "" })),
			Story.when(attempt),
			Story.rejected(new VaultArchivedError({ vault_id: vault.id })),
			Story.given(vault, new VaultDeleted({ next: "" })),
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
			Story.then(vault, new CredentialAttached({ credential_id: second.id })),
			Story.then(
				second,
				new CredentialCreated({
					vault_id: vault.id,
					auth: LINEAR,
					display_name: null,
					previous: credential.id,
				}),
			),
			Story.then(urlOf(LINEAR), new CredentialUrlClaimed({ credential_id: second.id })),
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
				Story.state(vault, { held: MAX_VAULT_CREDENTIALS }),
				Story.when(archive(first.ref, first.auth)),
				Story.then(vault, new CredentialDetached({ credential_id: first.ref.id, custody: "held" })),
				Story.then(first.ref, new CredentialArchived({ vault_id: vault.id })),
				Story.then(urlOf(first.auth), new CredentialUrlFreed()),
				...erased(first.ref),
				Story.state(vault, { held: MAX_VAULT_CREDENTIALS - 1, erasing: 0 }),
				Story.when(attempt),
				Story.then(vault, new CredentialAttached({ credential_id: extra.id })),
				Story.then(
					extra,
					new CredentialCreated({
						vault_id: vault.id,
						auth: GITHUB,
						display_name: null,
						previous: held.at(-1)?.ref.id ?? "",
					}),
				),
				Story.then(urlOf(GITHUB), new CredentialUrlClaimed({ credential_id: extra.id })),
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

	it.effect(
		"archives a credential once: it is no longer held, its URL is free, and custody confirms the erasure",
		() => {
			const replacement = Credential.ref("vcrd_002")
			return story(
				created,
				Story.clock(t0),
				...holding(credential, GITHUB),
				Story.clock(t1),
				Story.when(archive(credential, GITHUB)),
				Story.then(
					vault,
					new CredentialDetached({ credential_id: credential.id, custody: "held" }),
				),
				Story.then(credential, new CredentialArchived({ vault_id: vault.id })),
				Story.then(urlOf(GITHUB), new CredentialUrlFreed()),
				Story.state(credential, { status: "archived", custody: "erasing" }),
				Story.state(vault, { held: 0, erasing: 1 }),
				Story.view(CredentialView, credential, {
					custody: "erasing",
					archived_at: t1,
					updated_at: t1,
				}),
				Story.view(VaultView, vault, { custody: { storing: 0, held: 0, erasing: 1 } }),
				...erased(credential),
				Story.state(credential, { status: "archived", custody: "erased" }),
				Story.state(vault, { held: 0, erasing: 0 }),
				Story.view(CredentialView, credential, { custody: "erased", archived_at: t1 }),
				Story.view(VaultView, vault, { custody: { storing: 0, held: 0, erasing: 0 } }),
				Story.when(archive(credential, GITHUB)),
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
				Story.then(vault, new CredentialAttached({ credential_id: replacement.id })),
				Story.then(
					replacement,
					new CredentialCreated({
						vault_id: vault.id,
						auth: GITHUB,
						display_name: null,
						previous: credential.id,
					}),
				),
				Story.then(urlOf(GITHUB), new CredentialUrlClaimed({ credential_id: replacement.id })),
			)
		},
	)

	it.effect("confirms an erasure once, and only for a secret that is being erased", () => {
		const confirm = (vault_id: string) =>
			new ConfirmCredentialErased({
				vault_id: VaultId.make(vault_id),
				credential_id: credential.id,
			})
		return story(
			created,
			...holding(credential, GITHUB),
			Story.when(confirm(vault.id)),
			Story.then(credential),
			Story.then(vault),
			Story.state(credential, { custody: "held" }),
			Story.given(vault, new CredentialDetached({ credential_id: credential.id, custody: "held" })),
			Story.given(credential, new CredentialArchived({ vault_id: vault.id })),
			Story.when(confirm("vlt_other")),
			Story.then(credential),
			Story.state(credential, { custody: "erasing" }),
			Story.when(confirm(vault.id)),
			Story.then(credential, new CredentialSecretErased()),
			Story.then(vault, new CredentialErasureCounted({ credential_id: credential.id })),
			Story.when(confirm(vault.id)),
			Story.then(credential),
			Story.then(vault),
			Story.state(credential, { custody: "erased" }),
			Story.state(vault, { erasing: 0 }),
		)
	})

	it.effect(
		"deletes an active or an archived credential, answers a repeated delete, and never brings its id back",
		() => {
			const archived = Credential.ref("vcrd_002")
			return story(
				created,
				...holding(credential, GITHUB),
				...holding(archived, LINEAR, credential.id),
				Story.given(vault, new CredentialDetached({ credential_id: archived.id, custody: "held" })),
				Story.given(archived, new CredentialArchived({ vault_id: vault.id })),
				Story.given(urlOf(LINEAR), new CredentialUrlFreed()),
				Story.given(archived, new CredentialSecretErased()),
				Story.given(vault, new CredentialErasureCounted({ credential_id: archived.id })),
				Story.when(remove(credential, GITHUB)),
				Story.then(
					vault,
					new CredentialDetached({ credential_id: credential.id, custody: "held" }),
				),
				Story.then(credential, new CredentialDeleted({ vault_id: vault.id })),
				Story.then(urlOf(GITHUB), new CredentialUrlFreed()),
				Story.state(credential, { status: "deleted", custody: "erasing" }),
				...erased(credential),
				Story.state(credential, { status: "deleted", custody: "erased" }),
				Story.view(CredentialView, credential, Story.none),
				Story.state(vault, { held: 0, erasing: 0 }),
				Story.when(remove(archived, LINEAR)),
				Story.then(vault),
				Story.then(archived, new CredentialDeleted({ vault_id: vault.id })),
				Story.call(CredentialSecrets.erase, { vault_id: vault.id, credential_id: archived.id }),
				Story.succeed(CredentialSecrets.erase, undefined),
				Story.then(archived),
				Story.state(archived, { status: "deleted", custody: "erased" }),
				Story.view(CredentialView, archived, Story.none),
				Story.when(remove(credential, GITHUB)),
				Story.then(credential),
				Story.then(vault),
				Story.when(archive(credential, GITHUB)),
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
		},
	)

	it.effect("lets no other vault, and no other URL, touch a credential", () => {
		const other = Vault.ref("vlt_other")
		return story(
			created,
			Story.given(other, new VaultCreated({ display_name: "Mallory" })),
			...holding(credential, GITHUB),
			Story.when(archive(credential, GITHUB, other.id)),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(remove(credential, GITHUB, other.id)),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(archive(credential, LINEAR)),
			Story.rejected(new CredentialNotFound({ credential_id: credential.id })),
			Story.when(remove(credential, LINEAR)),
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
			Story.given(other, new VaultDeleted({ next: "" })),
			Story.when(new RetireCredential({ vault_id: other.id, credential_id: credential.id })),
			Story.then(credential),
			Story.then(other),
			Story.state(credential, { status: "active", vault_id: vault.id, custody: "held" }),
			Story.state(vault, { held: 1, last_attached: credential.id }),
			Story.state(urlOf(GITHUB), { holder: credential.id }),
		)
	})

	it.effect("retires nothing while the vault is live", () =>
		story(
			created,
			...holding(credential, GITHUB),
			Story.when(new RetireCredential({ vault_id: vault.id, credential_id: credential.id })),
			Story.then(credential),
			Story.state(credential, { status: "active", custody: "held" }),
		),
	)

	it.effect(
		"an archived vault lets go of every credential it held, newest first, and counts each erasure",
		() => {
			const second = Credential.ref("vcrd_002")
			return story(
				created,
				Story.clock(t0),
				...holding(credential, GITHUB),
				...holding(second, LINEAR, credential.id),
				Story.clock(t1),
				Story.when(new ArchiveVault({ vault_id: vault.id })),
				...sealed,
				Story.then(
					vault,
					new VaultArchived({ next: second.id }),
					new CredentialReleased({ credential_id: second.id, next: credential.id }),
					new CredentialReleased({ credential_id: credential.id, next: "" }),
				),
				Story.then(second, new CredentialArchived({ vault_id: vault.id })),
				Story.then(credential, new CredentialArchived({ vault_id: vault.id })),
				Story.call("second", CredentialSecrets.erase, {
					vault_id: vault.id,
					credential_id: second.id,
				}),
				Story.call("first", CredentialSecrets.erase, {
					vault_id: vault.id,
					credential_id: credential.id,
				}),
				Story.state(vault, { status: "archived", held: 0, erasing: 2, releasing: "" }),
				Story.view(VaultView, vault, {
					archived_at: t1,
					custody: { storing: 0, held: 0, erasing: 2 },
				}),
				Story.succeed("first", CredentialSecrets.erase, undefined),
				Story.succeed("second", CredentialSecrets.erase, undefined),
				Story.then(credential, new CredentialSecretErased()),
				Story.then(second, new CredentialSecretErased()),
				Story.then(
					vault,
					new CredentialErasureCounted({ credential_id: credential.id }),
					new CredentialErasureCounted({ credential_id: second.id }),
				),
				Story.state(vault, { status: "archived", held: 0, erasing: 0 }),
				Story.state(credential, { custody: "erased" }),
				Story.state(second, { custody: "erased" }),
				Story.view(VaultView, vault, { custody: { storing: 0, held: 0, erasing: 0 } }),
				Story.view(CredentialView, credential, { archived_at: t1, custody: "erased" }),
				Story.view(CredentialView, second, { archived_at: t1, custody: "erased" }),
			)
		},
	)

	it.effect(
		"an ended vault walks past a credential that already ended, and does not count it twice",
		() => {
			const second = Credential.ref("vcrd_002")
			return story(
				created,
				...holding(credential, GITHUB),
				...holding(second, LINEAR, credential.id),
				Story.given(vault, new VaultArchived({ next: second.id })),
				Story.state(vault, { held: 0, erasing: 2, releasing: second.id }),
				Story.when(archive(second, LINEAR)),
				Story.then(vault),
				Story.then(second, new CredentialArchived({ vault_id: vault.id })),
				...erased(second),
				Story.state(vault, { held: 0, erasing: 1, releasing: second.id }),
				Story.when(new RetireCredential({ vault_id: vault.id, credential_id: second.id })),
				Story.then(
					vault,
					new CredentialReleased({ credential_id: second.id, next: credential.id }),
					new CredentialReleased({ credential_id: credential.id, next: "" }),
				),
				Story.then(second),
				Story.then(credential, new CredentialArchived({ vault_id: vault.id })),
				...erased(credential),
				Story.state(vault, { held: 0, erasing: 0, releasing: "" }),
				Story.state(credential, { custody: "erased" }),
				Story.when(new RetireCredential({ vault_id: vault.id, credential_id: second.id })),
				Story.then(vault),
				Story.then(second),
			)
		},
	)

	it.effect(
		"deleting an archived vault starts again from the newest credential and deletes each one",
		() => {
			const second = Credential.ref("vcrd_002")
			return story(
				created,
				...holding(credential, GITHUB),
				...holding(second, LINEAR, credential.id),
				Story.given(vault, new VaultArchived({ next: second.id })),
				Story.given(second, new CredentialArchived({ vault_id: vault.id })),
				Story.given(
					vault,
					new CredentialReleased({ credential_id: second.id, next: credential.id }),
				),
				Story.when(new DeleteVault({ vault_id: vault.id })),
				...sealed,
				Story.then(
					vault,
					new VaultDeleted({ next: second.id }),
					new CredentialReleased({ credential_id: second.id, next: credential.id }),
					new CredentialReleased({ credential_id: credential.id, next: "" }),
				),
				Story.then(second, new CredentialDeleted({ vault_id: vault.id })),
				Story.then(credential, new CredentialDeleted({ vault_id: vault.id })),
				Story.call("second", CredentialSecrets.erase, {
					vault_id: vault.id,
					credential_id: second.id,
				}),
				Story.call("first", CredentialSecrets.erase, {
					vault_id: vault.id,
					credential_id: credential.id,
				}),
				Story.succeed("second", CredentialSecrets.erase, undefined),
				Story.succeed("first", CredentialSecrets.erase, undefined),
				Story.then(second, new CredentialSecretErased()),
				Story.then(credential, new CredentialSecretErased()),
				Story.then(
					vault,
					new CredentialErasureCounted({ credential_id: second.id }),
					new CredentialErasureCounted({ credential_id: credential.id }),
				),
				Story.state(vault, { status: "deleted", held: 0, erasing: 0, releasing: "" }),
				Story.state(second, { status: "deleted", custody: "erased" }),
				Story.state(credential, { status: "deleted", custody: "erased" }),
			)
		},
	)

	it.effect(
		"deletes every credential of a deleted vault, asking custody again until it answers",
		() =>
			redeliveryStory(
				created,
				...holding(credential, GITHUB),
				Story.when(new DeleteVault({ vault_id: vault.id })),
				...sealed,
				Story.then(
					vault,
					new VaultDeleted({ next: credential.id }),
					new CredentialReleased({ credential_id: credential.id, next: "" }),
				),
				Story.then(credential, new CredentialDeleted({ vault_id: vault.id })),
				Story.call(CredentialSecrets.erase, { vault_id: vault.id, credential_id: credential.id }),
				Story.die(CredentialSecrets.erase, new Error("custody unreachable")),
				...erased(credential),
				Story.view(VaultView, vault, Story.none),
				Story.view(CredentialView, credential, Story.none),
				Story.state(credential, { status: "deleted", vault_id: vault.id, custody: "erased" }),
				Story.state(vault, { status: "deleted", erasing: 0 }),
			),
	)
})
