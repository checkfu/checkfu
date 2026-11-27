import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Mac from "effect/crypto/Mac"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { publishDomain } from "../CustomDomain.ts"
import { DEFAULT_STORAGE_SCOPE, storageScope } from "../Placement.ts"
import { linkKey, linkUrl, publicationUrl, signLink, verifyLink } from "./ArtifactLink.ts"
import type { ArtifactLinkClaims } from "./ArtifactLink.ts"
import { ArtifactLinkSecret, ContentWorker } from "./Content.ts"

export interface ArtifactLinksService {
	readonly mint: (claims: Omit<ArtifactLinkClaims, "scope">) => Effect.Effect<string>
	readonly verify: (token: string) => Effect.Effect<ArtifactLinkClaims | null>
	readonly publicationUrl: (address: string) => Effect.Effect<string>
}

export class ArtifactLinks extends Context.Service<ArtifactLinks, ArtifactLinksService>()(
	"@checkfu/api/ArtifactLinks",
) {}

const verifiedIn = (scope: string, mac: Mac.Mac["Service"], key: Mac.Key, token: string) =>
	Effect.map(
		Effect.flatMap(Clock.currentTimeMillis, (now) => verifyLink(mac, key, token, now)),
		(claims) => (claims === null || claims.scope !== scope ? null : claims),
	)

export const artifactLinksFor = (origin: string, secret: string, scope: string, domain?: string) =>
	Layer.effect(
		ArtifactLinks,
		Effect.gen(function* () {
			const mac = yield* Mac.Mac
			const key = yield* Effect.orDie(linkKey(secret))
			return {
				mint: (claims) =>
					Effect.map(signLink(mac, key, { ...claims, scope }), (token) => linkUrl(origin, token)),
				verify: (token) => verifiedIn(scope, mac, key, token),
				publicationUrl: (address) => Effect.succeed(publicationUrl(origin, domain, address)),
			}
		}),
	)

export const TEST_CONTENT_ORIGIN = "http://content.test"
export const TEST_LINK_SECRET = "test-link-secret"

export const ArtifactLinksTest = artifactLinksFor(
	TEST_CONTENT_ORIGIN,
	TEST_LINK_SECRET,
	DEFAULT_STORAGE_SCOPE,
).pipe(Layer.provide(Mac.layerWebCrypto), Layer.provide(SecureRandom.layerWebCrypto))

export const ArtifactLinksLive = Layer.effect(
	ArtifactLinks,
	Effect.gen(function* () {
		const mac = yield* Mac.Mac
		const scope = yield* Effect.orDie(storageScope)
		const domain = yield* Effect.orDie(publishDomain)
		const secret = yield* (yield* ArtifactLinkSecret).text
		const origin = yield* (yield* ContentWorker).url
		const runtime = yield* Cloudflare.Worker
		const resolved = yield* Effect.cached(
			Effect.gen(function* () {
				const key = yield* linkKey(Redacted.value(yield* secret))
				const base = yield* origin
				if (base === undefined) {
					return yield* Effect.die(new Error("The content Worker has no URL."))
				}
				return { key, base }
			}).pipe(Effect.provideService(RuntimeContext, runtime), Effect.orDie),
		)
		return {
			mint: (claims) =>
				Effect.flatMap(resolved, ({ key, base }) =>
					Effect.map(signLink(mac, key, { ...claims, scope }), (token) => linkUrl(base, token)),
				),
			verify: (token) => Effect.flatMap(resolved, ({ key }) => verifiedIn(scope, mac, key, token)),
			publicationUrl: (address) =>
				Effect.map(resolved, ({ base }) => publicationUrl(base, domain, address)),
		}
	}),
)
