import { parsePublicHttpsWebhookUrl } from "@checkfu/domain/Webhook/WebhookUrl"
import * as Schema from "effect/Schema"
import { authenticateDashboardSession } from "../../../app/worker.ts"
import type { CustodySql } from "../../src/Connection/SecretCustody.ts"
import { openOAuthCustodyFixture } from "./OAuthCustodyFixture.ts"

const lifetime = 300_000
const cookie = "__Host-checkfu_oauth"
const callbackPath = "/connections/callback"
const confirmPath = "/connections/confirm"
const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" }
const refuse = (status = 400) => new Response(null, { status, headers: privateHeaders })
const cookieValue = (request: Request, name: string) =>
	(request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim().split("=", 2))
		.find(([key]) => key === name)?.[1]
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
const one = (params: URLSearchParams, name: string): string | undefined => {
	const values = params.getAll(name)
	return values.length === 1 && values[0] !== "" ? values[0] : undefined
}

const resourceMetadata = Schema.decodeUnknownSync(
	Schema.Struct({
		resource: Schema.String,
		authorization_servers: Schema.Array(Schema.String),
	}),
)
const serverMetadata = Schema.decodeUnknownSync(
	Schema.Struct({
		issuer: Schema.String,
		authorization_endpoint: Schema.String,
		token_endpoint: Schema.String,
		authorization_response_iss_parameter_supported: Schema.Literal(true),
		code_challenge_methods_supported: Schema.Array(Schema.String),
	}),
)
const tokenReply = Schema.decodeUnknownSync(
	Schema.Struct({
		access_token: Schema.String.check(Schema.isMinLength(1)),
		refresh_token: Schema.String.check(Schema.isMinLength(1)),
		token_type: Schema.Literal("Bearer"),
		scope: Schema.String,
	}),
)
const attemptRow = Schema.decodeUnknownSync(
	Schema.Struct({
		attempt: Schema.String,
		state: Schema.String,
		browser: Schema.String,
		credential: Schema.String,
		generation: Schema.Int,
		expires: Schema.Int,
		target: Schema.String,
		issuer: Schema.String,
		endpoint: Schema.String,
		verifier: Schema.NullOr(Schema.String),
		code: Schema.NullOr(Schema.String),
		phase: Schema.Literals(["begun", "received", "claimed", "complete", "denied"]),
	}),
)

export interface OAuthCallbackSettings {
	readonly origin: string
	readonly apiKey: string
	readonly resource: string
	readonly issuer: string
	readonly clientId: string
	readonly clientSecret: string
	readonly scope: string
	readonly now: () => number
	readonly fetch: typeof globalThis.fetch
}

export const openOAuthCallbackFixture = (sql: CustodySql, settings: OAuthCallbackSettings) => {
	const redirectUri = settings.origin + callbackPath
	sql.exec(
		"CREATE TABLE IF NOT EXISTS oauth_attempts (" +
			"attempt TEXT PRIMARY KEY, state TEXT NOT NULL UNIQUE, browser TEXT NOT NULL, " +
			"credential TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL, " +
			"target TEXT NOT NULL, issuer TEXT NOT NULL, endpoint TEXT NOT NULL, " +
			"verifier TEXT, code TEXT, phase TEXT NOT NULL)",
	)

	const custody = openOAuthCustodyFixture(
		sql,
		() => Promise.resolve({ type: "revoked" }),
		undefined,
		(credential) => {
			if (credential === undefined) {
				sql.exec("DELETE FROM oauth_attempts")
			} else {
				sql.exec("DELETE FROM oauth_attempts WHERE credential = ?", credential)
			}
		},
	)
	const expire = () => sql.exec("DELETE FROM oauth_attempts WHERE expires <= ?", settings.now())

	const readAttempt = (key: string) => {
		for (const row of sql.exec("SELECT * FROM oauth_attempts WHERE attempt = ?", key)) {
			return attemptRow(row)
		}
		return undefined
	}
	const owner = (request: Request) =>
		authenticateDashboardSession(request, settings.apiKey, settings.now())
	const sameOriginPost = (request: Request, path: string) =>
		request.method === "POST" &&
		request.url === settings.origin + path &&
		request.headers.get("origin") === settings.origin
	const fetchJson = async <A>(
		url: string,
		decode: (value: unknown) => A,
		init: RequestInit = {},
	): Promise<A> => {
		const response = await settings.fetch(url, { ...init, redirect: "manual" })
		if (response.status !== 200 || response.redirected) {
			throw new Error("The provider refused the request.")
		}
		return decode(await response.json())
	}
	const metadata = async () => {
		const resource = parsePublicHttpsWebhookUrl(settings.resource)
		const issuer = parsePublicHttpsWebhookUrl(settings.issuer)
		if (resource === null || issuer === null || new URL(issuer).search !== "") {
			throw new Error("The resource or issuer is unavailable.")
		}
		const origin = new URL(resource).origin
		const advertised = await fetchJson(
			origin + "/.well-known/oauth-protected-resource" + new URL(resource).pathname,
			resourceMetadata,
		)
		if (
			advertised.resource !== resource ||
			!advertised.authorization_servers.includes(settings.issuer)
		) {
			throw new Error("The resource did not authorize the configured issuer.")
		}
		const authority = new URL(issuer)
		const provider = await fetchJson(
			authority.origin +
				"/.well-known/oauth-authorization-server" +
				authority.pathname.replace(/\/$/u, ""),
			serverMetadata,
		)
		const authorization = parsePublicHttpsWebhookUrl(provider.authorization_endpoint)
		const endpoint = parsePublicHttpsWebhookUrl(provider.token_endpoint)
		if (
			provider.issuer !== settings.issuer ||
			!provider.code_challenge_methods_supported.includes("S256") ||
			authorization === null ||
			endpoint === null ||
			new URL(authorization).origin !== authority.origin ||
			new URL(endpoint).origin !== authority.origin
		) {
			throw new Error("The configured issuer metadata was not accepted.")
		}
		return { resource, authorization, endpoint }
	}

	const start = async (request: Request, credential: string): Promise<Response> => {
		const session = sameOriginPost(request, "/connections/start") ? await owner(request) : undefined
		if (session === undefined) {
			return refuse(401)
		}
		const generation = custody.generation(credential)
		if (generation === null) {
			return refuse(409)
		}
		const discovered = await metadata().catch(() => undefined)
		if (discovered === undefined) {
			return refuse()
		}
		const attempt = token()
		const state = token()
		const verifier = token() + token()
		const challenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		).toString("base64url")
		const reserved = sql.transaction(() => {
			if (custody.generation(credential) !== generation) {
				return false
			}
			sql.exec(
				"INSERT INTO oauth_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'begun')",
				attempt,
				state,
				session.browserBinding,
				credential,
				generation,
				settings.now() + lifetime,
				discovered.resource,
				settings.issuer,
				discovered.endpoint,
				verifier,
			)
			return true
		})
		if (!reserved) {
			return refuse(409)
		}
		const authorize = new URL(discovered.authorization)
		for (const [name, value] of Object.entries({
			response_type: "code",
			client_id: settings.clientId,
			redirect_uri: redirectUri,
			resource: discovered.resource,
			scope: settings.scope,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		})) {
			authorize.searchParams.set(name, value)
		}
		return new Response(null, {
			status: 303,
			headers: {
				...privateHeaders,
				location: authorize.href,
				"set-cookie":
					cookie + "=" + attempt + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300",
			},
		})
	}

	const callback = (request: Request): Response => {
		const url = new URL(request.url)
		const attempt = cookieValue(request, cookie)
		const state = one(url.searchParams, "state")
		const issuer = one(url.searchParams, "iss")
		const code = one(url.searchParams, "code")
		const error = one(url.searchParams, "error")
		if (
			request.method !== "GET" ||
			url.origin + url.pathname !== redirectUri ||
			attempt === undefined ||
			state === undefined ||
			issuer === undefined ||
			!(
				(code !== undefined && !url.searchParams.has("error")) ||
				(error === "access_denied" && !url.searchParams.has("code"))
			)
		) {
			return refuse()
		}
		const received = sql.transaction(() => {
			const current = readAttempt(attempt)
			if (
				current?.phase !== "begun" ||
				current.state !== state ||
				current.issuer !== issuer ||
				current.expires <= settings.now() ||
				custody.generation(current.credential) !== current.generation
			) {
				return false
			}
			if (code === undefined) {
				sql.exec(
					"UPDATE oauth_attempts SET phase = 'denied', verifier = NULL WHERE attempt = ?",
					attempt,
				)
			} else {
				sql.exec(
					"UPDATE oauth_attempts SET phase = 'received', code = ? WHERE attempt = ?",
					code,
					attempt,
				)
			}
			return true
		})
		return received
			? new Response(null, { status: 303, headers: { ...privateHeaders, location: confirmPath } })
			: refuse()
	}

	const confirm = async (request: Request): Promise<Response> => {
		const session = sameOriginPost(request, confirmPath) ? await owner(request) : undefined
		const key = cookieValue(request, cookie)
		if (session === undefined || key === undefined) {
			return refuse(401)
		}
		const claimed = sql.transaction(() => {
			const current = readAttempt(key)
			if (
				current?.phase !== "received" ||
				current.browser !== session.browserBinding ||
				current.code === null ||
				current.verifier === null ||
				current.expires <= settings.now() ||
				custody.generation(current.credential) !== current.generation
			) {
				return undefined
			}
			sql.exec(
				"UPDATE oauth_attempts SET phase = 'claimed', code = NULL, verifier = NULL WHERE attempt = ?",
				key,
			)
			return { ...current, code: current.code, verifier: current.verifier }
		})
		if (claimed === undefined) {
			return refuse(409)
		}
		const reply = await Promise.resolve()
			.then(async () => {
				// The fixture binds the token request to the selected issuer and resource.
				if (custody.generation(claimed.credential) !== claimed.generation) {
					return undefined
				}
				return fetchJson(claimed.endpoint, tokenReply, {
					method: "POST",
					headers: {
						authorization: "Basic " + btoa(settings.clientId + ":" + settings.clientSecret),
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: claimed.code,
						code_verifier: claimed.verifier,
						redirect_uri: redirectUri,
						resource: claimed.target,
					}),
				})
			})
			.catch(() => undefined)
		if (
			reply === undefined ||
			reply.scope !== settings.scope ||
			claimed.expires <= settings.now()
		) {
			return refuse(409)
		}
		const accepted = custody.commitAuthorization(
			claimed.credential,
			claimed.generation,
			{
				target: claimed.target,
				access: reply.access_token,
				refresh: reply.refresh_token,
			},
			() => {
				sql.exec("UPDATE oauth_attempts SET phase = 'complete' WHERE attempt = ?", key)
			},
		)
		return accepted ? refuse(204) : refuse(409)
	}
	return { start, callback, confirm, expire, custody }
}
