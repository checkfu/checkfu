import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "@effect/vitest"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { buildArtifactVersion } from "../src/Artifacts/ArtifactFiles.ts"
import type { ArtifactFileInput } from "../src/Artifacts/ArtifactFiles.ts"
import { makeSqlLedger } from "../src/Artifacts/ArtifactLedgerSql.ts"
import type { ArtifactSqlStorage } from "../src/Artifacts/ArtifactLedgerSql.ts"
import {
	ARTIFACT_WRITE_GRACE_MS,
	ORPHAN_RETRY_MS,
	makeArtifactOwner,
} from "../src/Artifacts/ArtifactOwnership.ts"
import type { ArtifactBucketWriter, ArtifactLedger } from "../src/Artifacts/ArtifactOwnership.ts"
import {
	ArtifactStore,
	ArtifactStoreError,
	artifactBlobKey,
	artifactManifestKey,
	artifactMarkerKey,
	artifactPrefix,
} from "../src/Artifacts/ArtifactStore.ts"
import type { ArtifactWriteRefused } from "../src/Artifacts/ArtifactStore.ts"
import { makeArtifactStoreMemory, makeMemoryLedger } from "../src/Artifacts/ArtifactStoreMemory.ts"
import { DEFAULT_STORAGE_SCOPE } from "../src/Placement.ts"

const sqliteStorage = (
	db: DatabaseSync,
	observe: (query: string, values: ReadonlyArray<SQLInputValue>) => void = () => {},
): ArtifactSqlStorage => ({
	sql: {
		exec: (query, ...bindings) => {
			const values = bindings as ReadonlyArray<SQLInputValue>
			observe(query, values)
			const statement = db.prepare(query)
			if (statement.columns().length > 0) {
				return statement.all(...values)
			}
			statement.run(...values)
			return []
		},
	},
	transactionSync: (run) => {
		db.exec("BEGIN")
		try {
			const result = run()
			db.exec("COMMIT")
			return result
		} catch (error) {
			db.exec("ROLLBACK")
			throw error
		}
	},
	deleteAll: async () => {
		for (const { name } of db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>) {
			db.exec(`DROP TABLE ${name}`)
		}
	},
})

const sqliteLedger = (): ArtifactLedger =>
	makeSqlLedger(sqliteStorage(new DatabaseSync(":memory:")))

const LEDGER_TABLES = new Set([
	"artifact_writes",
	"artifact_keys",
	"artifact_refs",
	"artifact_orphan_candidates",
])

const readMeter = (db: DatabaseSync) => {
	const meter = { reads: 0, scanned: new Set<string>() }
	const observe = (query: string, values: ReadonlyArray<SQLInputValue>) => {
		if (query.startsWith("CREATE")) {
			return
		}
		for (const step of db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values)) {
			const [, verb, table = ""] = /^(SCAN|SEARCH) (\w+)/.exec(String(step["detail"])) ?? []
			if (verb === "SEARCH") {
				meter.reads += 1
			} else if (verb === "SCAN" && LEDGER_TABLES.has(table)) {
				meter.scanned.add(table)
				meter.reads += Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"])
			}
		}
	}
	return { meter, observe }
}

const ID = "art_owner"
const SCOPE = DEFAULT_STORAGE_SCOPE

const setup = (
	ledger: ArtifactLedger,
	scope: string = SCOPE,
	shared?: Map<string, Uint8Array | string>,
) => {
	const objects = shared ?? new Map<string, Uint8Array | string>()
	const puts = new Map<string, number>()
	let clock = 0
	let alarm: number | null = null
	let failing: (key: string) => boolean = () => false
	let beforeDelete: Effect.Effect<void> = Effect.void
	let deletesFail = false
	let alarmsFail = false
	const slow = new Map<string, Promise<void>>()
	const store = (key: string, body: Uint8Array | string) => {
		objects.set(key, body)
		puts.set(key, (puts.get(key) ?? 0) + 1)
	}
	const bucket: ArtifactBucketWriter<never> = {
		put: (key, body) =>
			Effect.suspend(() => {
				if (failing(key)) {
					return Effect.fail(new ArtifactStoreError({ cause: new Error(`put ${key} failed`) }))
				}
				const gate = slow.get(key)
				return gate === undefined
					? Effect.sync(() => store(key, body))
					: Effect.promise(() => gate.then(() => store(key, body)))
			}),
		delete: (keys) =>
			Effect.suspend(() => beforeDelete).pipe(
				Effect.andThen(
					Effect.suspend(() => {
						if (deletesFail) {
							return Effect.fail(new ArtifactStoreError({ cause: new Error("delete failed") }))
						}
						for (const key of keys) {
							objects.delete(key)
						}
						return Effect.void
					}),
				),
			),
		list: (prefix) =>
			Effect.sync(() => [...objects.keys()].filter((key) => key.startsWith(prefix))),
	}
	const owner = makeArtifactOwner({
		scope,
		ledger,
		bucket,
		now: Effect.sync(() => clock),
		alarm: Effect.sync(() => alarm),
		setAlarm: (at) =>
			alarmsFail
				? Effect.die(new Error("setAlarm failed"))
				: Effect.sync(() => {
						alarm = at
					}),
	})
	return {
		owner,
		objects,
		puts,
		advance: (millis: number) => {
			clock += millis
		},
		alarm: () => alarm,
		fire: Effect.suspend(() => {
			alarm = null
			return owner.alarm
		}),
		failAlarms: (value: boolean) => {
			alarmsFail = value
		},
		failOn: (predicate: (key: string) => boolean) => {
			failing = predicate
		},
		failDeletes: (value: boolean) => {
			deletesFail = value
		},
		putAfter: (key: string, gate: Promise<void>) => {
			slow.set(key, gate)
		},
		onceBeforeDelete: (effect: Effect.Effect<void>) => {
			beforeDelete = Effect.andThen(
				Effect.sync(() => {
					beforeDelete = Effect.void
				}),
				effect,
			)
		},
	}
}

const build = (files: ReadonlyArray<ArtifactFileInput>) =>
	Effect.flatMap(Digest.Digest, (digest) => buildArtifactVersion(digest, files)).pipe(
		Effect.orDie,
		Effect.provide(Digest.layerWebCrypto),
	)

const keysOf = (built: Effect.Success<ReturnType<typeof build>>) => [
	...built.blobs.map((blob) => artifactBlobKey(SCOPE, ID, blob.sha256)),
	artifactManifestKey(SCOPE, ID, built.manifest_hash),
]

describe.each([
	["memory", makeMemoryLedger],
	["sqlite", sqliteLedger],
] as const)("artifact owner over the %s ledger", (_name, makeLedger) => {
	it.effect("writes a kept file once and reclaims only what a refused write added", () =>
		Effect.gen(function* () {
			const { owner, objects, puts } = setup(makeLedger())
			const shared = { path: "shared.txt", content: "shared" }
			const first = yield* build([shared, { path: "a.txt", content: "a" }])
			const second = yield* build([shared, { path: "b.txt", content: "b" }])
			yield* owner.stage(ID, "w1", first)
			yield* owner.markCommitted("w1", null)
			yield* owner.stage(ID, "w2", second)
			yield* owner.markCommitted("w2", null)
			expect(puts.get(artifactBlobKey(SCOPE, ID, second.blobs[0]?.sha256 ?? ""))).toBe(1)
			yield* owner.abandon(ID, "w2")
			yield* owner.abandon(ID, "w2")
			expect([...objects.keys()].sort()).toEqual(keysOf(first).sort())
		}),
	)

	it.effect(
		"forgets a confirmed write but keeps its files past a late stage or abandon of it",
		() =>
			Effect.gen(function* () {
				const ledger = makeLedger()
				const { owner, objects, advance, fire } = setup(ledger)
				const version = yield* build([
					{ path: "a.txt", content: "a" },
					{ path: "b.txt", content: "b" },
				])
				for (const writeId of ["w1", "w2", "w3"]) {
					yield* owner.stage(ID, writeId, version)
					yield* owner.markCommitted(writeId, null)
					yield* owner.confirm(ID, writeId)
					expect(ledger.findWrite(writeId)).toBeUndefined()
				}
				yield* owner.abandon(ID, "w1")
				const late = yield* build([
					{ path: "a.txt", content: "a" },
					{ path: "late.txt", content: "late" },
				])
				yield* owner.stage(ID, "w2", late)
				advance(ARTIFACT_WRITE_GRACE_MS)
				yield* fire
				expect([...objects.keys()].sort()).toEqual(keysOf(version).sort())
				expect(ledger.unreferenced()).toEqual([])
			}),
	)

	it.effect("keeps the files an unsettled write shares with a confirmed one", () =>
		Effect.gen(function* () {
			const { owner, objects } = setup(makeLedger())
			const shared = { path: "shared.txt", content: "shared" }
			const pending = yield* build([shared, { path: "p.txt", content: "p" }])
			const confirmed = yield* build([shared, { path: "c.txt", content: "c" }])
			yield* owner.stage(ID, "pending", pending)
			yield* owner.markCommitted("pending", null)
			yield* owner.stage(ID, "confirmed", confirmed)
			yield* owner.markCommitted("confirmed", null)
			yield* owner.confirm(ID, "confirmed")
			expect([...objects.keys()].sort()).toEqual(
				[...new Set([...keysOf(pending), ...keysOf(confirmed)])].sort(),
			)
			yield* owner.abandon(ID, "pending")
			expect([...objects.keys()].sort()).toEqual(keysOf(confirmed).sort())
			const after = yield* build([shared, { path: "n.txt", content: "n" }])
			yield* owner.stage(ID, "next", after)
			yield* owner.markCommitted("next", null)
			yield* owner.abandon(ID, "next")
			expect([...objects.keys()].sort()).toEqual(keysOf(confirmed).sort())
		}),
	)

	it.effect("abandons a write whose upload fails, keeping keys other writes hold", () =>
		Effect.gen(function* () {
			const { owner, objects, failOn } = setup(makeLedger())
			const kept = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, "w1", kept)
			failOn((key) => key.includes("/manifests/"))
			const failed = yield* build([
				{ path: "a.txt", content: "a" },
				{ path: "b.txt", content: "b" },
			])
			expect(Exit.isFailure(yield* Effect.exit(owner.stage(ID, "w2", failed)))).toBe(true)
			expect(Exit.isFailure(yield* Effect.exit(owner.markCommitted("w2", null)))).toBe(true)
			expect([...objects.keys()].sort()).toEqual(keysOf(kept).sort())
			failOn(() => false)
			yield* owner.markCommitted("w1", null)
		}),
	)

	it.effect("leaves a write staged when its marker cannot be written, and sweeps it later", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, failOn, advance, alarm } = setup(ledger)
			const version = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, "w1", version)
			failOn((key) => key === artifactMarkerKey(SCOPE, ID, "w1"))
			const marked = yield* Effect.exit(
				owner.markCommitted("w1", {
					artifact_id: ID,
					write_id: "w1",
					check: { kind: "create", manifest: version.manifest_hash },
				}),
			)
			expect(Exit.isFailure(marked)).toBe(true)
			expect(ledger.findWrite("w1")?.status).toBe("staged")
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
			advance(ARTIFACT_WRITE_GRACE_MS)
			yield* owner.sweep
			expect([...objects.keys()]).toEqual([])
		}),
	)

	it.effect("sweeps writes left staged past the grace period and refuses to commit them", () =>
		Effect.gen(function* () {
			const { owner, objects, advance, alarm, fire } = setup(makeLedger())
			const committed = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, "w1", committed)
			yield* owner.markCommitted("w1", null)
			const crashed = yield* build([
				{ path: "a.txt", content: "a" },
				{ path: "c.txt", content: "c" },
			])
			advance(1)
			yield* owner.stage(ID, "w2", crashed)
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
			advance(ARTIFACT_WRITE_GRACE_MS - 1)
			yield* fire
			expect(objects.size).toBe(keysOf(committed).length + 2)
			expect(alarm()).toBe(1 + ARTIFACT_WRITE_GRACE_MS)
			advance(1)
			expect(Exit.isFailure(yield* Effect.exit(owner.markCommitted("w2", null)))).toBe(true)
			yield* fire
			expect([...objects.keys()].sort()).toEqual(keysOf(committed).sort())
			expect(alarm()).toBeNull()
		}),
	)

	it.effect("forgets an abandoned write after the grace period and sweeps a late stage of it", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, failOn, advance, alarm, fire } = setup(ledger)
			const version = yield* build([{ path: "a.txt", content: "a" }])
			failOn((key) => key.includes("/manifests/"))
			expect(Exit.isFailure(yield* Effect.exit(owner.stage(ID, "w1", version)))).toBe(true)
			failOn(() => false)
			expect(ledger.findWrite("w1")?.status).toBe("abandoned")
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
			advance(ARTIFACT_WRITE_GRACE_MS)
			yield* fire
			expect(ledger.findWrite("w1")).toBeUndefined()
			expect(ledger.isEmpty()).toBe(true)
			expect(alarm()).toBeNull()
			expect([...objects.keys()]).toEqual([])

			yield* owner.stage(ID, "w1", version)
			expect(alarm()).toBe(2 * ARTIFACT_WRITE_GRACE_MS)
			advance(ARTIFACT_WRITE_GRACE_MS)
			expect(Exit.isFailure(yield* Effect.exit(owner.markCommitted("w1", null)))).toBe(true)
			yield* fire
			expect([...objects.keys()]).toEqual([])
			expect(ledger.isEmpty()).toBe(true)
			expect(alarm()).toBeNull()
		}),
	)

	it.effect("empties the ledger once an abandoned create is settled, retrying its marker", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, advance, alarm, fire, failDeletes } = setup(ledger)
			const version = yield* build([{ path: "a.txt", content: "a" }])
			const marker = artifactMarkerKey(SCOPE, ID, "w1")
			yield* owner.stage(ID, "w1", version)
			yield* owner.markCommitted("w1", {
				artifact_id: ID,
				write_id: "w1",
				check: { kind: "create", manifest: version.manifest_hash },
			})
			expect(objects.has(marker)).toBe(true)
			failDeletes(true)
			expect(Exit.isFailure(yield* Effect.exit(owner.abandon(ID, "w1")))).toBe(true)
			failDeletes(false)
			expect(objects.has(marker)).toBe(true)
			yield* owner.abandon(ID, "w1")
			expect([...objects.keys()]).toEqual([])
			advance(ARTIFACT_WRITE_GRACE_MS)
			yield* fire
			expect(ledger.isEmpty()).toBe(true)
			expect(alarm()).toBeNull()
		}),
	)

	it.effect("keeps a key that lost its last reference and gained one again before the alarm", () =>
		Effect.gen(function* () {
			const { owner, objects, advance, alarm, fire, failDeletes } = setup(makeLedger())
			const version = yield* build([{ path: "k.txt", content: "k" }])
			yield* owner.stage(ID, "w1", version)
			yield* owner.markCommitted("w1", null)
			failDeletes(true)
			expect(Exit.isFailure(yield* Effect.exit(owner.abandon(ID, "w1")))).toBe(true)
			expect(alarm()).toBe(ORPHAN_RETRY_MS)
			failDeletes(false)
			yield* owner.stage(ID, "w2", version)
			const armed = alarm()
			yield* owner.markCommitted("w2", null)
			advance(ORPHAN_RETRY_MS)
			yield* fire
			expect([...objects.keys()].sort()).toEqual(keysOf(version).sort())
			expect(armed).toBe(ORPHAN_RETRY_MS)
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
		}),
	)

	it.effect("retries a failed delete on time however often uploads arrive", () =>
		Effect.gen(function* () {
			const { owner, objects, advance, alarm, fire, failDeletes } = setup(makeLedger())
			const lost = yield* build([{ path: "lost.txt", content: "lost" }])
			yield* owner.stage(ID, "lost", lost)
			yield* owner.markCommitted("lost", null)
			failDeletes(true)
			expect(Exit.isFailure(yield* Effect.exit(owner.abandon(ID, "lost")))).toBe(true)
			failDeletes(false)
			expect(alarm()).toBe(ORPHAN_RETRY_MS)
			const later: Array<Effect.Success<ReturnType<typeof build>>> = []
			for (let index = 0; index < 4; index++) {
				advance(ORPHAN_RETRY_MS / 4 - 1)
				const version = yield* build([{ path: `v${index}.txt`, content: String(index) }])
				later.push(version)
				yield* owner.stage(ID, `w${index}`, version)
				yield* owner.markCommitted(`w${index}`, null)
				expect(alarm()).toBe(ORPHAN_RETRY_MS)
			}
			advance(4)
			yield* fire
			expect([...objects.keys()].sort()).toEqual(later.flatMap(keysOf).sort())
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
		}),
	)

	it.effect("backs off a sweep whose deletes fail and finishes it once storage recovers", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, advance, alarm, fire, failDeletes } = setup(ledger)
			yield* owner.stage(ID, "w1", yield* build([{ path: "a.txt", content: "a" }]))
			failDeletes(true)
			advance(ARTIFACT_WRITE_GRACE_MS)
			for (let attempt = 0; attempt < 3; attempt++) {
				const now = ARTIFACT_WRITE_GRACE_MS + attempt * ORPHAN_RETRY_MS
				expect(Exit.isFailure(yield* Effect.exit(fire))).toBe(true)
				expect(alarm()).toBe(now + ORPHAN_RETRY_MS)
				advance(ORPHAN_RETRY_MS)
			}
			failDeletes(false)
			yield* fire
			expect([...objects.keys()]).toEqual([])
			expect(ledger.isEmpty()).toBe(true)
			expect(alarm()).toBeNull()
		}),
	)

	it.effect("arms the cleanup alarm before it records a staged write", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, alarm, failAlarms } = setup(ledger)
			const version = yield* build([{ path: "a.txt", content: "a" }])
			failAlarms(true)
			expect(Exit.isFailure(yield* Effect.exit(owner.stage(ID, "w1", version)))).toBe(true)
			failAlarms(false)
			expect(ledger.findWrite("w1")).toBeUndefined()
			expect(objects.size).toBe(0)
			yield* owner.stage(ID, "w1", version)
			expect(alarm()).toBe(ARTIFACT_WRITE_GRACE_MS)
		}),
	)

	it.effect("fails the alarm when it cannot rearm, so the platform delivers it again", () =>
		Effect.gen(function* () {
			const { owner, objects, advance, alarm, fire, failAlarms } = setup(makeLedger())
			const first = yield* build([{ path: "a.txt", content: "a" }])
			const second = yield* build([{ path: "b.txt", content: "b" }])
			yield* owner.stage(ID, "w1", first)
			advance(1)
			yield* owner.stage(ID, "w2", second)
			advance(ARTIFACT_WRITE_GRACE_MS - 1)
			failAlarms(true)
			expect(Exit.isFailure(yield* Effect.exit(fire))).toBe(true)
			expect(alarm()).toBeNull()
			failAlarms(false)
			yield* fire
			expect(alarm()).toBe(1 + ARTIFACT_WRITE_GRACE_MS)
			expect([...objects.keys()].sort()).toEqual(keysOf(second).sort())
		}),
	)

	it.effect("keeps each scope's files apart and purges an artifact in one scope only", () =>
		Effect.gen(function* () {
			const objects = new Map<string, Uint8Array | string>()
			const here = setup(makeLedger(), SCOPE, objects)
			const there = setup(makeLedger(), "eu", objects)
			const version = yield* build([{ path: "a.txt", content: "a" }])
			yield* here.owner.stage(ID, "w1", version)
			yield* here.owner.markCommitted("w1", null)
			yield* there.owner.stage(ID, "w1", version)
			yield* there.owner.markCommitted("w1", null)
			const thereKeys = [
				...version.blobs.map((blob) => artifactBlobKey("eu", ID, blob.sha256)),
				artifactManifestKey("eu", ID, version.manifest_hash),
			]
			expect([...objects.keys()].sort()).toEqual([...keysOf(version), ...thereKeys].sort())
			yield* here.owner.purge(ID)
			expect([...objects.keys()].sort()).toEqual(thereKeys.sort())
		}),
	)

	it.effect("purges every stored key and forgets every write", () =>
		Effect.gen(function* () {
			const { owner, objects, puts } = setup(makeLedger())
			const version = yield* build([{ path: "a.txt", content: "a" }])
			yield* owner.stage(ID, "w1", version)
			yield* owner.markCommitted("w1", null)
			objects.set(`${artifactPrefix(SCOPE, ID)}stray`, "x")
			yield* owner.purge(ID)
			expect([...objects.keys()]).toEqual([])
			expect(Exit.isFailure(yield* Effect.exit(owner.markCommitted("w1", null)))).toBe(true)
			yield* owner.stage(ID, "w2", version)
			expect(puts.get(keysOf(version)[0] ?? "")).toBe(2)
		}),
	)

	it.live("lets every upload of a failed write finish before reclaiming it", () =>
		Effect.gen(function* () {
			const ledger = makeLedger()
			const { owner, objects, failOn, putAfter } = setup(ledger)
			const version = yield* build([
				{ path: "a.txt", content: "a" },
				{ path: "b.txt", content: "b" },
			])
			const [late, fast] = version.blobs.map((blob) => artifactBlobKey(SCOPE, ID, blob.sha256))
			let release = () => {}
			putAfter(
				late ?? "",
				new Promise<void>((resolve) => {
					release = resolve
				}),
			)
			failOn((key) => key === fast)
			const staging = yield* Effect.forkChild(Effect.exit(owner.stage(ID, "w1", version)))
			yield* Effect.sleep("20 millis")
			release()
			expect(Exit.isFailure(yield* Fiber.join(staging))).toBe(true)
			yield* Effect.sleep("20 millis")
			expect([...objects.keys()]).toEqual([])
			expect(ledger.unreferenced()).toEqual([])
		}),
	)

	const racedByStage = (
		env: ReturnType<typeof setup>,
		version: Effect.Success<ReturnType<typeof build>>,
		operation: Effect.Effect<void, ArtifactStoreError>,
	) =>
		Effect.gen(function* () {
			let racer: Fiber.Fiber<void, ArtifactStoreError | ArtifactWriteRefused> | undefined
			env.onceBeforeDelete(
				Effect.gen(function* () {
					racer = yield* Effect.forkDetach(
						Effect.andThen(
							env.owner.stage(ID, "racer", version),
							env.owner.markCommitted("racer", null),
						),
					)
					yield* Fiber.await(racer).pipe(Effect.timeout("100 millis"), Effect.ignore)
				}),
			)
			yield* operation
			expect(racer).toBeDefined()
			yield* Fiber.join(racer ?? (yield* Effect.die("no racer")))
			for (const key of keysOf(version)) {
				expect(env.objects.has(key), key).toBe(true)
			}
		})

	it.live("keeps a key another write stages while an abandon is deleting it", () =>
		Effect.gen(function* () {
			const env = setup(makeLedger())
			const version = yield* build([{ path: "k.txt", content: "k" }])
			yield* env.owner.stage(ID, "loser", version)
			yield* env.owner.markCommitted("loser", null)
			yield* racedByStage(env, version, env.owner.abandon(ID, "loser"))
		}),
	)

	it.live("keeps a key another write stages while a sweep is deleting it", () =>
		Effect.gen(function* () {
			const env = setup(makeLedger())
			const version = yield* build([{ path: "k.txt", content: "k" }])
			yield* env.owner.stage(ID, "crashed", version)
			env.advance(ARTIFACT_WRITE_GRACE_MS)
			yield* racedByStage(env, version, env.owner.sweep)
		}),
	)

	it.live("keeps a key another write stages while a purge is deleting it", () =>
		Effect.gen(function* () {
			const env = setup(makeLedger())
			const version = yield* build([{ path: "k.txt", content: "k" }])
			yield* env.owner.stage(ID, "first", version)
			yield* env.owner.markCommitted("first", null)
			yield* racedByStage(env, version, env.owner.purge(ID))
		}),
	)
})

describe("artifact store in memory", () => {
	it.effect("refuses a blob whose bytes do not match its sha256 and stores a matching one", () =>
		Effect.gen(function* () {
			const memory = makeArtifactStoreMemory({ scope: SCOPE })
			const built = yield* build([{ path: "a.txt", content: "a" }])
			const blob = built.blobs[0]
			if (blob === undefined) {
				return yield* Effect.die("no blob")
			}
			const key = artifactBlobKey(SCOPE, ID, blob.sha256)
			const corrupted = { ...built, blobs: [{ ...blob, bytes: new TextEncoder().encode("b") }] }
			const refused = yield* Effect.exit(
				ArtifactStore.use((store) => store.putVersion(ID, corrupted)).pipe(
					Effect.provide(memory.layer),
				),
			)
			expect(Exit.isFailure(refused)).toBe(true)
			expect(memory.objects.has(key)).toBe(false)
			yield* ArtifactStore.use((store) => store.putVersion(ID, built)).pipe(
				Effect.provide(memory.layer),
			)
			expect(memory.objects.get(key)).toEqual(blob.bytes)
		}),
	)
})

describe("artifact ledger over SQLite", () => {
	it.effect("reads the same rows to stage a version however many versions came before", () =>
		Effect.gen(function* () {
			const db = new DatabaseSync(":memory:")
			const { meter, observe } = readMeter(db)
			const { owner } = setup(makeSqlLedger(sqliteStorage(db, observe)))
			meter.scanned.clear()
			const reads: Array<number> = []
			for (let index = 0; index < 200; index++) {
				const version = yield* build([{ path: `f${index}.txt`, content: `${index}` }])
				const before = meter.reads
				yield* owner.stage(ID, `w${index}`, version)
				reads.push(meter.reads - before)
				yield* owner.markCommitted(`w${index}`, null)
			}
			yield* owner.abandon(ID, "w199")
			yield* owner.sweep
			expect(reads.at(-1)).toBeLessThanOrEqual((reads[0] ?? 0) + 2)
			expect([...meter.scanned]).toEqual(["artifact_orphan_candidates"])
		}),
	)

	it.effect("keeps one row per file however many confirmed versions repeat it", () =>
		Effect.gen(function* () {
			const db = new DatabaseSync(":memory:")
			const { owner } = setup(makeSqlLedger(sqliteStorage(db)))
			const version = yield* build(
				Array.from({ length: 8 }, (_, index) => ({ path: `f${index}.txt`, content: `${index}` })),
			)
			for (let index = 0; index < 5; index++) {
				yield* owner.stage(ID, `w${index}`, version)
				yield* owner.markCommitted(`w${index}`, null)
				yield* owner.confirm(ID, `w${index}`)
			}
			const count = (table: string) =>
				Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"])
			expect(count("artifact_writes")).toBe(0)
			expect(count("artifact_refs")).toBe(0)
			expect(count("artifact_keys")).toBe(keysOf(version).length)
		}),
	)

	it.effect(
		"deletes its tables once nothing is left and creates them again on the next write",
		() =>
			Effect.gen(function* () {
				const db = new DatabaseSync(":memory:")
				const ledger = makeSqlLedger(sqliteStorage(db))
				const { owner, failOn, advance, fire } = setup(ledger)
				const tables = () =>
					db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().length
				const version = yield* build([{ path: "a.txt", content: "a" }])
				failOn((key) => key.includes("/manifests/"))
				expect(Exit.isFailure(yield* Effect.exit(owner.stage(ID, "w1", version)))).toBe(true)
				failOn(() => false)
				expect(tables()).toBeGreaterThan(0)
				advance(ARTIFACT_WRITE_GRACE_MS)
				yield* fire
				expect(tables()).toBe(0)
				yield* owner.stage(ID, "w2", version)
				yield* owner.markCommitted("w2", null)
				expect(ledger.findWrite("w2")?.status).toBe("committed")
				yield* owner.purge(ID)
				expect(tables()).toBe(0)
				expect(makeSqlLedger(sqliteStorage(db)).isEmpty()).toBe(true)
				expect(tables()).toBe(0)
			}),
	)

	it("finds orphans left before candidates were tracked, scanning the keys only once", () => {
		const db = new DatabaseSync(":memory:")
		const legacy = makeSqlLedger(sqliteStorage(db))
		legacy.saveKey("kept", true)
		legacy.hold("kept", "w1")
		legacy.saveKey("orphan", true)
		db.exec("DROP TABLE artifact_orphan_candidates")
		const first = readMeter(db)
		const reopened = makeSqlLedger(sqliteStorage(db, first.observe))
		expect(first.meter.scanned.has("artifact_keys")).toBe(true)
		expect(reopened.unreferenced()).toEqual(["orphan"])
		const second = readMeter(db)
		makeSqlLedger(sqliteStorage(db, second.observe))
		expect(second.meter.scanned.has("artifact_keys")).toBe(false)
	})
})
