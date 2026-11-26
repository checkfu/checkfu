import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeSecretCustody } from "./SecretCustody.ts"
import type { HeldSecret, PutMode, PutOutcome } from "./SecretCustody.ts"

export class Connection extends Cloudflare.DurableObject<Connection>()(
	"Connection",
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		let made: ReturnType<typeof makeSecretCustody> | undefined
		const custody = () =>
			(made ??= makeSecretCustody({
				exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
				transaction: (run) => storage.transactionSync(run),
			}))
		return Effect.succeed({
			putSecret: (
				credentialId: string,
				secret: HeldSecret,
				target: string,
				mode: PutMode,
			): Effect.Effect<PutOutcome> =>
				Effect.sync(() => custody().put(credentialId, secret, target, mode)),
			eraseSecret: (credentialId: string): Effect.Effect<void> =>
				Effect.sync(() => custody().erase(credentialId)),
			seal: (): Effect.Effect<void> => Effect.sync(() => custody().seal()),
			usable: (credentialId: string): Effect.Effect<boolean> =>
				Effect.sync(() => custody().usable(credentialId)),
		})
	}),
) {}
