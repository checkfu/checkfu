import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { CredentialCreated } from "./CreateCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialSecrets } from "./CredentialSecrets.external.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"

/**
 * One policy for the whole life of a secret, so a credential's facts reach its
 * custody in the order they happened: kept once created, erased once archived
 * or deleted.
 */
export class SettleCredentialSecret extends Domain.Policy("SettleCredentialSecret", {
	from: Credential,
	on: [CredentialCreated, CredentialArchived, CredentialDeleted],
}) {}

export const SettleCredentialSecretLive = SettleCredentialSecret.toLayer(
	Effect.gen(function* () {
		const secrets = yield* CredentialSecrets
		// Custody that cannot be reached fails the delivery, which is then delivered again.
		return ({ source, event }) =>
			event._tag === "vault_credential.created"
				? secrets.keep({ credential_id: source.id })
				: secrets.erase({ credential_id: source.id })
	}),
)
