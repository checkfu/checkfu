import * as Mac from "effect/crypto/Mac"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Base64Url from "effect/encoding/Base64Url"
import * as Hex from "effect/encoding/Hex"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { PUBLICATION_TOKEN_LENGTH, PublicationAddress } from "@checkfu/sdk/Schemas"

export {
	DEFAULT_LINK_TTL_SECONDS,
	MAX_LINK_TTL_SECONDS,
	MIN_LINK_TTL_SECONDS,
} from "@checkfu/sdk/Schemas"

export const CONTENT_PATH_PREFIX = "/a/"

const SEPARATOR = "."

const Segment = Schema.String.check(Schema.isPattern(/^[\w-]+$/))

const canonicalNumber = (text: string | undefined): number | undefined => {
	const value = Number(text)
	return text !== undefined && String(value) === text ? value : undefined
}

export const ArtifactLinkClaims = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Struct({
			scope: Segment,
			artifactId: Segment,
			version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 })),
			expiresAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999_999_999_999 })),
		}),
		SchemaTransformation.transformEffect({
			decode: (text: string) => {
				const [scope, artifactId, version, expiresAt, ...rest] = text.split(SEPARATOR)
				const parsedVersion = canonicalNumber(version)
				const parsedExpiresAt = canonicalNumber(expiresAt)
				return scope === undefined ||
					artifactId === undefined ||
					parsedVersion === undefined ||
					parsedExpiresAt === undefined ||
					rest.length > 0
					? Effect.fail(
							new SchemaIssue.InvalidValue(
								{ message: "Expected scope.artifactId.version.expiresAt" },
								text,
							),
						)
					: Effect.succeed({
							scope,
							artifactId,
							version: parsedVersion,
							expiresAt: parsedExpiresAt,
						})
			},
			encode: (claims) =>
				Effect.succeed(
					[claims.scope, claims.artifactId, claims.version, claims.expiresAt].join(SEPARATOR),
				),
		}),
	),
)
export type ArtifactLinkClaims = typeof ArtifactLinkClaims.Type

const encodeClaims = Schema.encodeEffect(ArtifactLinkClaims)
const decodeClaims = Schema.decodeUnknownExit(ArtifactLinkClaims)

const utf8Encoder = new TextEncoder()

export const linkKey = (secret: string) => Mac.key(Mac.hmacSha256, utf8Encoder.encode(secret))

export const signLink = (
	mac: Mac.Mac["Service"],
	key: Mac.Key,
	claims: ArtifactLinkClaims,
): Effect.Effect<string> =>
	Effect.gen(function* () {
		const text = yield* encodeClaims(claims)
		const tag = yield* mac.sign(key, utf8Encoder.encode(text))
		return `${Base64Url.encode(text)}.${Base64Url.encode(tag)}`
	}).pipe(Effect.orDie)

export const verifyLink = (
	mac: Mac.Mac["Service"],
	key: Mac.Key,
	token: string,
	nowMillis: number,
): Effect.Effect<ArtifactLinkClaims | null> =>
	Effect.gen(function* () {
		const parts = token.split(".")
		if (parts.length !== 2) {
			return null
		}
		const text = Base64Url.decodeString(parts[0] ?? "")
		const tag = Base64Url.decode(parts[1] ?? "")
		if (Result.isFailure(text) || Result.isFailure(tag)) {
			return null
		}
		if (Base64Url.encode(text.success) !== parts[0] || Base64Url.encode(tag.success) !== parts[1]) {
			return null
		}
		const claims = decodeClaims(text.success)
		if (Exit.isFailure(claims)) {
			return null
		}
		const valid = yield* mac
			.verify(key, tag.success, utf8Encoder.encode(text.success))
			.pipe(Effect.orElseSucceed(() => false))
		if (!valid || nowMillis >= claims.value.expiresAt * 1000) {
			return null
		}
		return claims.value
	})

export const linkUrl = (contentOrigin: string, token: string) =>
	`${contentOrigin.replace(/\/+$/, "")}${CONTENT_PATH_PREFIX}${token}/`

export const PUBLICATION_PATH_PREFIX = "/p/"

export const isPublicationAddress = Schema.is(PublicationAddress)

const ARTIFACT_ID_PREFIX = "art_"

export const newPublicationToken = (random: SecureRandom.SecureRandom["Service"]) =>
	Effect.map(random.randomBytes(16), (bytes) =>
		BigInt(`0x${Hex.encode(bytes)}`)
			.toString(36)
			.padStart(PUBLICATION_TOKEN_LENGTH, "0"),
	)

export const publicationAddress = (artifactId: string, token: string) =>
	`a${artifactId.slice(ARTIFACT_ID_PREFIX.length)}-${token}`

export const parsePublicationAddress = (address: string) =>
	isPublicationAddress(address)
		? {
				artifactId: `${ARTIFACT_ID_PREFIX}${address.slice(1, -PUBLICATION_TOKEN_LENGTH - 1)}`,
				token: address.slice(-PUBLICATION_TOKEN_LENGTH),
			}
		: null

export const publicationUrl = (
	contentOrigin: string,
	publishDomain: string | undefined,
	address: string,
) =>
	publishDomain === undefined
		? `${contentOrigin.replace(/\/+$/, "")}${PUBLICATION_PATH_PREFIX}${address}/`
		: `https://${address}.${publishDomain}/`

export const publicationOfHost = (hostname: string, publishDomain: string | undefined) =>
	publishDomain !== undefined && `.${hostname}`.endsWith(`.${publishDomain}`)
		? hostname.slice(0, -publishDomain.length - 1)
		: undefined
