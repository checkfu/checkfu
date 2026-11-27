import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ArtifactDatabase, ArtifactDatabaseError } from "./ArtifactDatabase.ts"
import { makeArtifactDocuments } from "./ArtifactDocuments.ts"
import type { ArtifactDocuments, DocumentsSql } from "./ArtifactDocuments.ts"

export const makeDocumentsSqlite = () => {
	const db = new DatabaseSync(":memory:")
	let failNext: string | undefined
	const sql: DocumentsSql = {
		exec: (query, ...bindings) => {
			if (failNext !== undefined && query.startsWith(failNext)) {
				failNext = undefined
				throw new Error(`stopped at ${query}`)
			}
			const statement = db.prepare(query)
			const values: ReadonlyArray<SQLInputValue> = bindings
			if (statement.columns().length > 0) {
				return statement.all(...values)
			}
			statement.run(...values)
			return []
		},
		transaction: (run) => {
			db.exec("BEGIN IMMEDIATE")
			try {
				const result = run()
				db.exec("COMMIT")
				return result
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
	}
	return {
		sql,
		failAt: (statementPrefix: string) => {
			failNext = statementPrefix
		},
	}
}

const run = <A>(evaluate: () => A) =>
	Effect.try({ try: evaluate, catch: (cause) => new ArtifactDatabaseError({ cause }) })

export const makeArtifactDatabaseMemory = () => {
	const databases = new Map<string, ArtifactDocuments>()
	const of = (artifactId: string) => {
		const existing = databases.get(artifactId)
		if (existing !== undefined) {
			return existing
		}
		const made = makeArtifactDocuments(makeDocumentsSqlite().sql)
		databases.set(artifactId, made)
		return made
	}
	return {
		opened: () => [...databases.keys()],
		layer: Layer.succeed(ArtifactDatabase, {
			get: (artifactId, collection, id) => run(() => of(artifactId).get(collection, id)),
			list: (artifactId, collection, after, limit) =>
				run(() => of(artifactId).list(collection, after, limit)),
			write: (artifactId, collection, id, body, mode) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					run(() => of(artifactId).write(collection, id, body, mode, now)),
				),
			remove: (artifactId, collection, id) => run(() => of(artifactId).remove(collection, id)),
			usage: (artifactId) => run(() => of(artifactId).usage()),
			erase: (artifactId) => run(() => of(artifactId).erase()),
		}),
	}
}
