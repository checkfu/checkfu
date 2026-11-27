import * as Domain from "@alchemy.run/domain"
import * as Effect from "effect/Effect"
import { CredentialArchived } from "./ArchiveCredential.command.ts"
import { Credential } from "./Credential.aggregate.ts"
import { CredentialDeleted } from "./DeleteCredential.command.ts"
import {
	RetryCredentialErasure,
	CredentialErasureRetryDue,
} from "./RetryCredentialErasure.command.ts"
import { makeRevokeCredentialSecret } from "./RevokeCredentialSecret.ts"

export class SettleCredentialSecret extends Domain.Policy("SettleCredentialSecret", {
	from: Credential,
	on: [CredentialArchived, CredentialDeleted, CredentialErasureRetryDue],
}) {}

export const SettleCredentialSecretLive = SettleCredentialSecret.toLayer(
	Effect.gen(function* () {
		const revoke = yield* makeRevokeCredentialSecret
		const credentials = yield* Credential
		return Effect.fn(function* ({ source, event }) {
			yield* revoke(event.vault_id, source.id).pipe(
				Effect.catchTag("CredentialSecretsUnavailable", () =>
					credentials.schedule(new RetryCredentialErasure({ credential_id: source.id }), {
						after: "5 seconds",
						commandId: "retry-erasure",
					}),
				),
			)
		})
	}),
)
