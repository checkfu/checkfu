import * as Schema from "effect/Schema"
import type { CustodySql } from "../../src/Connection/SecretCustody.ts"

const Grant = Schema.Struct({
	credential_id: Schema.String,
	target: Schema.String,
	generation: Schema.Finite,
	access_token: Schema.NullOr(Schema.String),
	refresh_token: Schema.NullOr(Schema.String),
	dispatched: Schema.Finite,
	status: Schema.Literals(["ready", "reauthorize", "erased"]),
})
type Grant = typeof Grant.Type

export type RefreshReply =
	| { readonly type: "rotated"; readonly access: string; readonly refresh: string }
	| { readonly type: "revoked" }

type Result = "ready" | "reauthorize" | "erased" | "superseded"
type Provider = (target: string, refreshToken: string) => Promise<RefreshReply>

const decode = Schema.decodeUnknownSync(Grant)
const clearGrant = `UPDATE oauth_grants
	SET generation = generation + 1, access_token = NULL, refresh_token = NULL, dispatched = 0, status = ?`

export const openOAuthCustodyFixture = (
	sql: CustodySql,
	provider: Provider,
	beforeSend: () => Promise<void> = () => Promise.resolve(),
) => {
	sql.exec(`CREATE TABLE IF NOT EXISTS oauth_grants (
		credential_id TEXT PRIMARY KEY, target TEXT NOT NULL, generation INTEGER NOT NULL,
		access_token TEXT, refresh_token TEXT, dispatched INTEGER NOT NULL, status TEXT NOT NULL
	)`)
	sql.exec(
		`CREATE TABLE IF NOT EXISTS oauth_vault (id INTEGER PRIMARY KEY, sealed INTEGER NOT NULL)`,
	)
	sql.exec(`CREATE TABLE IF NOT EXISTS oauth_tombstones (credential_id TEXT PRIMARY KEY)`)
	const read = (credentialId: string): Grant | undefined => {
		for (const entry of sql.exec(
			"SELECT * FROM oauth_grants WHERE credential_id = ?",
			credentialId,
		)) {
			return decode(entry)
		}
		return undefined
	}
	const sealed = () => Array.from(sql.exec("SELECT 1 FROM oauth_vault WHERE sealed = 1")).length > 0
	const erased = (id: string) =>
		sealed() ||
		Array.from(sql.exec("SELECT 1 FROM oauth_tombstones WHERE credential_id = ?", id)).length > 0
	const inFlight = new Map<
		string,
		{ readonly generation: number | undefined; readonly pending: Promise<Result> }
	>()
	const begin = (credentialId: string) =>
		sql.transaction((): Grant | Result => {
			const grant = read(credentialId)
			if (erased(credentialId) || grant === undefined || grant.status === "erased") {
				return "erased"
			}
			if (grant.status === "reauthorize") {
				return "reauthorize"
			}
			if (grant.dispatched !== 0) {
				sql.exec(`${clearGrant} WHERE credential_id = ?`, "reauthorize", credentialId)
				return "reauthorize"
			}
			sql.exec("UPDATE oauth_grants SET dispatched = 1 WHERE credential_id = ?", credentialId)
			return grant
		})
	const refresh = async (credentialId: string): Promise<Result> => {
		const original = begin(credentialId)
		if (typeof original === "string") {
			return original
		}
		if (original.refresh_token === null) {
			throw new Error("The fixture did not have an active refresh grant.")
		}
		await beforeSend()
		const dispatch = read(credentialId)
		if (erased(credentialId)) {
			return "erased"
		}
		if (dispatch?.generation !== original.generation || dispatch.dispatched !== 1) {
			return "superseded"
		}
		const reply = await provider(original.target, original.refresh_token)
		return sql.transaction(() => {
			const current = read(credentialId)
			if (erased(credentialId) || current === undefined || current.status === "erased") {
				return "erased"
			}
			if (current.generation !== original.generation || current.dispatched !== 1) {
				return "superseded"
			}
			if (reply.type === "revoked") {
				sql.exec(`${clearGrant} WHERE credential_id = ?`, "reauthorize", credentialId)
				return "reauthorize"
			}
			sql.exec(
				`UPDATE oauth_grants SET access_token = ?, refresh_token = ?,
				generation = generation + 1, dispatched = 0 WHERE credential_id = ?`,
				reply.access,
				reply.refresh,
				credentialId,
			)
			return "ready"
		})
	}
	return {
		authorize: (id: string, target: string, access: string, token: string) =>
			sql.transaction(() => {
				if (erased(id)) {
					return false
				}
				sql.exec(
					`INSERT INTO oauth_grants VALUES (?, ?, 1, ?, ?, 0, 'ready')
					ON CONFLICT (credential_id) DO UPDATE SET target = excluded.target,
					access_token = excluded.access_token, refresh_token = excluded.refresh_token,
					generation = oauth_grants.generation + 1, dispatched = 0, status = 'ready'`,
					id,
					target,
					access,
					token,
				)
				return true
			}),
		refresh: (id: string) => {
			const generation = read(id)?.generation
			const current = inFlight.get(id)
			if (current !== undefined && current.generation === generation) {
				return current.pending
			}
			const pending = refresh(id).finally(() => {
				if (inFlight.get(id)?.pending === pending) {
					inFlight.delete(id)
				}
			})
			inFlight.set(id, { generation, pending })
			return pending
		},
		erase: (id: string) =>
			sql.transaction(() => {
				sql.exec("INSERT OR IGNORE INTO oauth_tombstones VALUES (?)", id)
				sql.exec(`${clearGrant} WHERE credential_id = ?`, "erased", id)
			}),
		seal: () =>
			sql.transaction(() => {
				sql.exec("INSERT OR REPLACE INTO oauth_vault VALUES (1, 1)")
				sql.exec(clearGrant, "erased")
			}),
		overview: (id: string) => {
			const grant = read(id)
			if (grant === undefined) {
				return null
			}
			return {
				id: grant.credential_id,
				target: grant.target,
				generation: grant.generation,
				status: grant.dispatched === 1 ? "refreshing" : grant.status,
			}
		},
		tokenFor: (id: string, target: string) => {
			const grant = read(id)
			return !erased(id) &&
				grant?.status === "ready" &&
				grant.dispatched === 0 &&
				grant.target === target
				? grant.access_token
				: null
		},
	}
}
