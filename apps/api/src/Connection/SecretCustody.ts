import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const CUSTODY_TABLES = {
	secrets:
		"CREATE TABLE IF NOT EXISTS secrets (credential_id TEXT PRIMARY KEY, secret TEXT NOT NULL, target TEXT NOT NULL)",
	tombstones: "CREATE TABLE IF NOT EXISTS tombstones (credential_id TEXT PRIMARY KEY)",
	vault:
		"CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), sealed INTEGER NOT NULL)",
} as const

export const HeldSecret = Schema.Union([
	Schema.Struct({ type: Schema.Literal("static_bearer"), token: Schema.String }),
])
export type HeldSecret = typeof HeldSecret.Type

export const PutMode = Schema.Literals(["create", "replace"])
export type PutMode = typeof PutMode.Type

export const PutOutcome = Schema.Struct({
	refused: Schema.NullOr(Schema.Literal("erased")),
})
export type PutOutcome = typeof PutOutcome.Type

const HeldSecretJson = Schema.fromJsonString(HeldSecret)
const encodeHeld = Schema.encodeSync(HeldSecretJson)

const SecretRow = Schema.Struct({
	secret: HeldSecretJson,
	target: Schema.String,
})
const decodeSecretRow = Schema.decodeUnknownOption(SecretRow)

export interface CustodySql {
	readonly exec: (
		query: string,
		...bindings: ReadonlyArray<string | number | null>
	) => Iterable<object>
	readonly transaction: <A>(run: () => A) => A
}

export const makeSecretCustody = (sql: CustodySql) => {
	for (const table of Object.values(CUSTODY_TABLES)) {
		sql.exec(table)
	}
	const first = (query: string, ...bindings: ReadonlyArray<string>) => {
		for (const row of sql.exec(query, ...bindings)) {
			return row
		}
		return undefined
	}
	const gone = (credentialId: string): boolean =>
		first("SELECT 1 FROM vault WHERE sealed = 1") !== undefined ||
		first("SELECT 1 FROM tombstones WHERE credential_id = ?", credentialId) !== undefined
	const held = (credentialId: string) =>
		Option.getOrNull(
			decodeSecretRow(
				first("SELECT secret, target FROM secrets WHERE credential_id = ?", credentialId),
			),
		)
	const read = (
		credentialId: string,
	): { readonly secret: HeldSecret; readonly target: string } | null => {
		const row = gone(credentialId) ? null : held(credentialId)
		return row === null ? null : { secret: row.secret, target: row.target }
	}
	return {
		put: (credentialId: string, secret: HeldSecret, target: string, mode: PutMode): PutOutcome =>
			sql.transaction((): PutOutcome => {
				if (gone(credentialId)) {
					return { refused: "erased" }
				}
				sql.exec(
					mode === "replace"
						? "INSERT INTO secrets (credential_id, secret, target) VALUES (?, ?, ?) ON CONFLICT (credential_id) DO UPDATE SET secret = excluded.secret, target = excluded.target"
						: "INSERT INTO secrets (credential_id, secret, target) VALUES (?, ?, ?) ON CONFLICT (credential_id) DO NOTHING",
					credentialId,
					encodeHeld(secret),
					target,
				)
				return { refused: null }
			}),
		erase: (credentialId: string): void => {
			sql.transaction(() => {
				sql.exec("DELETE FROM secrets WHERE credential_id = ?", credentialId)
				sql.exec("INSERT OR IGNORE INTO tombstones (credential_id) VALUES (?)", credentialId)
			})
		},
		seal: (): void => {
			sql.transaction(() => {
				sql.exec("DELETE FROM secrets")
				sql.exec("DELETE FROM tombstones")
				sql.exec(
					"INSERT INTO vault (id, sealed) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET sealed = 1",
				)
			})
		},
		usable: (credentialId: string): boolean => read(credentialId) !== null,
		read,
	}
}

export type SecretCustody = ReturnType<typeof makeSecretCustody>
