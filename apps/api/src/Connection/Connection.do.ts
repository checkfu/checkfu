import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import { makeSecretCustody } from "./SecretCustody.ts"

/**
 * One object per credential, named by the credential's id. It is the only
 * place the credential's secret exists.
 */
export class Connection extends Cloudflare.DurableObject<Connection>()(
	"Connection",
	Effect.map(Cloudflare.DurableObjectState, (state) => {
		const { storage } = state.raw
		const custody = makeSecretCustody(
			{
				get: (key) => storage.kv.get<string>(key),
				put: (key, value) => {
					storage.kv.put(key, value)
				},
				clear: () => storage.deleteAll(),
				setAlarm: (at) => storage.setAlarm(at),
				deleteAlarm: () => storage.deleteAlarm(),
			},
			() => Date.now(),
		)
		return Effect.succeed({
			alarm: () => Effect.promise(() => custody.expire()),
			storeSecret: (secret: string): Effect.Effect<boolean> =>
				Effect.promise(() => custody.store(secret)),
			replaceSecret: (secret: string): Effect.Effect<boolean> =>
				Effect.sync(() => custody.replace(secret)),
			keepSecret: (): Effect.Effect<void> => Effect.promise(() => custody.keep()),
			erase: (): Effect.Effect<void> => Effect.promise(() => custody.erase()),
			// For server-side dispatch only: nothing that answers a client may return it.
			readSecret: (): Effect.Effect<string | null> => Effect.sync(() => custody.read()),
		})
	}),
) {}
