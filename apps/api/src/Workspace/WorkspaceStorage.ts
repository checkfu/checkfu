import * as Predicate from "effect/Predicate"

export interface WorkspaceSql {
	readonly exec: (query: string) => Iterable<unknown>
}

const OWN_TABLES = String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\_cf\_%' ESCAPE '\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`

export const purgeTables = (sql: WorkspaceSql): void => {
	const names = [...sql.exec(OWN_TABLES)].flatMap((row) =>
		Predicate.hasProperty(row, "name") && typeof row.name === "string" ? [row.name] : [],
	)
	for (const name of names) {
		sql.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`)
	}
}
