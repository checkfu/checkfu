import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import { makeRevokeCredentialSecret } from "./RevokeCredentialSecret.ts"

export class SettleCredentialSecret extends Domain.Policy("SettleCredentialSecret", {
	from: Credential,
	on: [CredentialArchived, CredentialDeleted],
}) {}

export const SettleCredentialSecretLive = SettleCredentialSecret.toLayer(
	Effect.gen(function* () {
		const revoke = yield* makeRevokeCredentialSecret
		return ({ source, event }) => revoke(event.vault_id, source.id)
	}),
)
