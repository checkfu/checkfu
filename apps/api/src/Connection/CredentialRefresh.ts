import { Credential } from "@checkfu/domain/Vault/Credential.aggregate"
import { CredentialId } from "@checkfu/domain/Vault/Credential.id"
import { FailCredentialRefresh } from "@checkfu/domain/Vault/FailCredentialRefresh.command"
import { RecordCredentialRefresh } from "@checkfu/domain/Vault/RecordCredentialRefresh.command"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ConnectionExecutor } from "./CredentialCustody.ts"

/**
 * Records on the credential what its connection's last token refresh came to, then tells the
 * connection it is recorded. The connection lives in the harness Worker, which cannot reach the
 * domain, so the API asks: after each turn of a session that uses the credential, and before
 * each read of it. Each outcome is recorded once, by its count, however often it is asked for.
 */
export const makeCredentialRefreshRecorder = Effect.gen(function* () {
	const connections = yield* ConnectionExecutor
	const credentials = yield* Credential
	return Effect.fn("Connection.recordCredentialRefresh")(
		function* (credentialId: string) {
			const report = yield* connections.refreshReport(credentialId)
			if (report === null) {
				return
			}
			const credential_id = CredentialId.make(credentialId)
			const commandId = `${credentialId}:refresh:${report.refreshes}`
			const { revision } = report
			yield* (
				report.refresh_failed
					? credentials.send(new FailCredentialRefresh({ credential_id, revision }), { commandId })
					: credentials.send(
							new RecordCredentialRefresh({
								credential_id,
								// An expiry no date can hold is recorded as unknown rather than failing every read.
								expires_at:
									report.expires_at === null
										? null
										: Option.getOrNull(DateTime.make(report.expires_at)),
								revision,
							}),
							{ commandId },
						)
			).pipe(
				// A credential that is gone or archived has nothing left to say this about.
				Effect.catchTag(["CredentialNotFound", "CredentialArchivedError"], () => Effect.void),
			)
			yield* connections.acknowledgeRefresh(credentialId, report.refreshes)
		},
		// Asked again next time; a read or a turn never fails for it.
		(effect, credentialId) =>
			Effect.catchTag(effect, "ConnectionCallFailed", (error) =>
				Effect.logWarning("Credential refresh not recorded", credentialId, error.cause),
			),
	)
})
