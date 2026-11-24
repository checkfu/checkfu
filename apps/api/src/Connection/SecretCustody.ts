import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const UNCONFIRMED_SECRET_TTL_MS = 24 * 60 * 60 * 1000

const SECRET = "secret"
const TARGET = "target"
const STATUS = "status"
const REFRESHES = "refreshes"
/** Changes with every write of the secret, so a refresh that began earlier can tell. */
const REVISION = "revision"
const REPORTED = "reported"

type CustodyStatus = "unconfirmed" | "kept" | "erased"

const HeldRefresh = Schema.Struct({
	token_endpoint: Schema.String,
	client_id: Schema.String,
	scope: Schema.NullOr(Schema.String),
	auth: Schema.Union([
		Schema.Struct({ type: Schema.Literal("none") }),
		Schema.Struct({
			type: Schema.Literals(["client_secret_basic", "client_secret_post"]),
			client_secret: Schema.String,
		}),
	]),
	refresh_token: Schema.String,
})
export type HeldRefresh = typeof HeldRefresh.Type

export const HeldPlacement = Schema.Union([
	Schema.Struct({
		in: Schema.Literal("header"),
		name: Schema.String,
		prefix: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ in: Schema.Literal("query"), name: Schema.String }),
])
export type HeldPlacement = typeof HeldPlacement.Type

/** Everything secret about one credential, as its connection holds it. */
export const HeldSecret = Schema.Union([
	Schema.Struct({ type: Schema.Literal("static_bearer"), token: Schema.String }),
	// Where the key goes is no secret, but it is fixed with the key and travels with it.
	Schema.Struct({
		type: Schema.Literal("api_key"),
		token: Schema.String,
		placement: HeldPlacement,
	}),
	Schema.Struct({
		type: Schema.Literal("mcp_oauth"),
		access_token: Schema.String,
		// Milliseconds since the epoch; null when the expiry is not known.
		expires_at: Schema.NullOr(Schema.Finite),
		refresh: Schema.NullOr(HeldRefresh),
		// The authorization server refused a refresh: nothing is tried again until new tokens arrive.
		refresh_failed: Schema.Boolean,
	}),
])
export type HeldSecret = typeof HeldSecret.Type
export type HeldOAuth = Extract<HeldSecret, { readonly type: "mcp_oauth" }>
export type HeldApiKey = Extract<HeldSecret, { readonly type: "api_key" }>

export const SecretReplacement = Schema.Union([
	Schema.Struct({ type: Schema.Literal("static_bearer"), token: Schema.String }),
	Schema.Struct({ type: Schema.Literal("api_key"), token: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("mcp_oauth"),
		access_token: Schema.String,
		expires_at: Schema.NullOr(Schema.Finite),
		refresh_token: Schema.NullOr(Schema.String),
	}),
])
export type SecretReplacement = typeof SecretReplacement.Type

/** What a credential's connection says about its token, with no secret in it. */
export const CustodyReport = Schema.Struct({
	/** Counts refresh outcomes, so each is recorded once. */
	refreshes: Schema.Int,
	/** The secret's revision when this was reported, so an older report never outranks a rotation. */
	revision: Schema.Int,
	expires_at: Schema.NullOr(Schema.Finite),
	refresh_failed: Schema.Boolean,
})
export type CustodyReport = typeof CustodyReport.Type

const HeldSecretJson = Schema.fromJsonString(HeldSecret)
const decodeHeld = Schema.decodeUnknownOption(HeldSecretJson)
const encodeHeld = Schema.encodeSync(HeldSecretJson)

export interface CustodyStorage {
	readonly get: (key: string) => string | undefined
	readonly put: (key: string, value: string) => void
	readonly clear: () => Promise<void>
	readonly setAlarm: (at: number) => Promise<void>
	readonly deleteAlarm: () => Promise<void>
}

/**
 * Runs one piece of work at a time, in the order asked: a token refresh, a
 * replacement and an erasure of the same secret never interleave.
 */
const makeExclusive = () => {
	let tail: Promise<unknown> = Promise.resolve()
	return <A>(work: () => A | Promise<A>): Promise<A> => {
		const run = tail.then(work)
		tail = run.catch(() => undefined)
		return run
	}
}

/**
 * Custody of one credential's secret. A secret arrives before the credential
 * is known to exist, so it is held unconfirmed and erases itself unless the
 * credential's creation confirms it. A confirmed secret that is erased is
 * never held again.
 */
export const makeSecretCustody = (storage: CustodyStorage, now: () => number) => {
	const exclusive = makeExclusive()
	const status = (): CustodyStatus | undefined => {
		const stored = storage.get(STATUS)
		return stored === "unconfirmed" || stored === "kept" || stored === "erased" ? stored : undefined
	}
	const held = (): boolean => {
		const current = status()
		return current === "kept" || current === "unconfirmed"
	}
	const read = (): HeldSecret | null => {
		const stored = held() ? storage.get(SECRET) : undefined
		return stored === undefined ? null : Option.getOrNull(decodeHeld(stored))
	}
	const counter = (key: string): number => Number(storage.get(key) ?? "0")
	const bump = (): number => {
		const next = counter(REVISION) + 1
		storage.put(REVISION, String(next))
		return next
	}
	const eraseNow = async (): Promise<void> => {
		const confirmed = status() !== "unconfirmed"
		await storage.clear()
		await storage.deleteAlarm()
		if (confirmed) {
			storage.put(STATUS, "erased")
		}
	}
	const replaceNow = (replacement: SecretReplacement): number | null => {
		const current = read()
		if (current === null || current.type !== replacement.type) {
			return null
		}
		if (replacement.type === "static_bearer") {
			storage.put(SECRET, encodeHeld(replacement))
			return bump()
		}
		if (replacement.type === "api_key") {
			if (current.type !== "api_key") {
				return null
			}
			storage.put(SECRET, encodeHeld({ ...current, token: replacement.token }))
			return bump()
		}
		if (current.type !== "mcp_oauth") {
			return null
		}
		if (replacement.refresh_token !== null && current.refresh === null) {
			return null
		}
		storage.put(
			SECRET,
			encodeHeld({
				type: "mcp_oauth",
				access_token: replacement.access_token,
				expires_at: replacement.expires_at,
				refresh:
					current.refresh === null || replacement.refresh_token === null
						? current.refresh
						: { ...current.refresh, refresh_token: replacement.refresh_token },
				refresh_failed: false,
			}),
		)
		const revision = bump()
		// Whatever the old tokens' last refresh came to is no longer news.
		storage.put(REPORTED, String(counter(REFRESHES)))
		return revision
	}
	return {
		store: (secret: HeldSecret, target: string): Promise<boolean> =>
			exclusive(async () => {
				const current = status()
				if (current === "kept" || current === "erased") {
					return false
				}
				storage.put(SECRET, encodeHeld(secret))
				storage.put(TARGET, target)
				storage.put(STATUS, "unconfirmed")
				bump()
				await storage.setAlarm(now() + UNCONFIRMED_SECRET_TTL_MS)
				return true
			}),
		/**
		 * Replaces the secret with one of the same kind; what it is sent to and
		 * refreshed by stays. A refresh attempt that is out finishes first, and the
		 * replacement applies over what it stored. The new revision, or null when
		 * nothing was replaced.
		 */
		replace: (replacement: SecretReplacement): Promise<number | null> =>
			exclusive(() => replaceNow(replacement)),
		keep: (): Promise<void> =>
			exclusive(async () => {
				if (status() === "unconfirmed") {
					storage.put(STATUS, "kept")
					await storage.deleteAlarm()
				}
			}),
		erase: (): Promise<void> => exclusive(eraseNow),
		read,
		/** Runs `work` with no store, replacement, erasure or other refresh attempt in between. */
		exclusive,
		/** The secret's current revision: every store, replacement and refresh moves it on. */
		revision: (): number => counter(REVISION),
		/**
		 * Stores what a refresh came to, in one write, and counts it, but only over
		 * the revision the refresh started from. False once nothing is held, or once
		 * the secret was replaced or refreshed meanwhile.
		 */
		refreshed: (next: HeldOAuth, from: number): boolean => {
			if (!held() || counter(REVISION) !== from) {
				return false
			}
			storage.put(SECRET, encodeHeld(next))
			storage.put(REFRESHES, String(counter(REFRESHES) + 1))
			storage.put(REVISION, String(from + 1))
			return true
		},
		/** The one URL the held secret may be sent to; null once nothing is held. */
		target: (): string | null => (held() ? (storage.get(TARGET) ?? null) : null),
		report: (): CustodyReport | null => {
			const current = read()
			return current === null || current.type !== "mcp_oauth"
				? null
				: {
						refreshes: counter(REFRESHES),
						revision: counter(REVISION),
						expires_at: current.expires_at,
						refresh_failed: current.refresh_failed,
					}
		},
		/** Whether a refresh outcome has not yet reached the credential's record. */
		unreported: (): boolean => held() && counter(REPORTED) < counter(REFRESHES),
		reported: (refreshes: number): void => {
			if (held() && refreshes > counter(REPORTED)) {
				storage.put(REPORTED, String(refreshes))
			}
		},
		expire: (): Promise<void> =>
			exclusive(async () => {
				if (status() === "unconfirmed") {
					await eraseNow()
				}
			}),
	}
}

export type SecretCustody = ReturnType<typeof makeSecretCustody>
