import { isDeepStrictEqual } from "node:util"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Arbitrary from "effect/Arbitrary"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Digest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import { RULES, parseViewShapeId, persistedShapes } from "./Shapes.ts"
import type { PersistedShape } from "./Shapes.ts"

export const Baseline = Schema.Struct({
	label: Schema.String.check(Schema.isMinLength(1)),
	cut_at: Schema.String,
	schemas: Schema.Record(Schema.String, Schema.String),
	shapes: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
})
export type Baseline = typeof Baseline.Type

export const PersistedLock = Schema.Struct({
	version: Schema.Literal(1),
	retired: Schema.Record(Schema.String, Schema.String),
	reviewed: Schema.Record(
		Schema.String,
		Schema.Struct({ schema: Schema.String, reason: Schema.String.check(Schema.isMinLength(1)) }),
	),
	baselines: Schema.Array(Baseline),
})
export type PersistedLock = typeof PersistedLock.Type

export const PersistedLockJson = Schema.fromJsonString(PersistedLock, { space: "\t" })
const decodeBaselineJson = Schema.decodeSync(Schema.fromJsonString(Baseline))

export class PersistedLockError extends Schema.TaggedError<
	PersistedLockError,
	{ readonly brand: unique symbol }
>()("PersistedLockError", {
	message: Schema.String,
}) {}

export const PersistedServicesLive = Layer.merge(BunServices.layer, Digest.layerWebCrypto)

export const LOCK_FILE_URL = new URL("./Persisted.lock.json", import.meta.url)

export const SAMPLES_PER_SHAPE = 8

const textEncoder = new TextEncoder()

const describeFailure = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause)

const lockFilePath: Effect.Effect<string, PersistedLockError, Path.Path> = Effect.flatMap(
	Path.Path,
	(path) =>
		path.fromFileUrl(LOCK_FILE_URL).pipe(
			Effect.mapError(
				(error) =>
					new PersistedLockError({
						message: `Cannot resolve Persisted.lock.json path: ${error.message}`,
					}),
			),
		),
)

export const schemaFingerprint = (
	shape: PersistedShape,
): Effect.Effect<string, never, Digest.Digest> =>
	Effect.flatMap(Digest.Digest, (digest) =>
		digest.digestHex(
			Digest.sha256,
			textEncoder.encode(
				JSON.stringify(Schema.toJsonSchemaDocument(Schema.toCodecJson(shape.schema))),
			),
		),
	)

export const sampleEncoded = (
	shape: PersistedShape,
	count: number = SAMPLES_PER_SHAPE,
): Effect.Effect<ReadonlyArray<unknown>, PersistedLockError> =>
	Effect.gen(function* () {
		const arbitrary = yield* Effect.try({
			try: () => Arbitrary.schema(shape.schema),
			catch: (cause) =>
				new PersistedLockError({
					message: `${shape.id}: cannot generate values: ${describeFailure(cause)}`,
				}),
		})
		const values = yield* Arbitrary.sampleEffect(arbitrary, { count, seed: shape.id }).pipe(
			Effect.mapError(
				(error) =>
					new PersistedLockError({
						message: `${shape.id}: generated ${error.generated} of ${count} values before giving up`,
					}),
			),
		)
		const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(shape.schema))
		return yield* Effect.forEach(values, (value) =>
			encode(value).pipe(
				Effect.mapError(
					(error) =>
						new PersistedLockError({ message: `${shape.id}: has no JSON form: ${error.message}` }),
				),
			),
		)
	})

export const decodeFailure = (
	shape: PersistedShape,
	sample: unknown,
): Effect.Effect<string | null> =>
	Schema.decodeUnknownEffect(Schema.toCodecJson(shape.schema))(sample).pipe(
		Effect.as(null),
		Effect.catch((error) => Effect.succeed(error.message)),
	)

export const lockProblems = (
	lock: PersistedLock,
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): Effect.Effect<ReadonlyArray<string>, never, Digest.Digest> =>
	Effect.gen(function* () {
		const current = new Map(shapes.map((shape) => [shape.id, shape]))
		const currentViews = new Map(
			shapes.flatMap((shape) => {
				const view = parseViewShapeId(shape.id)
				return view === null ? [] : [[view.name, view.version] as const]
			}),
		)
		const problems: Array<string> = []
		const unreviewed = new Set<string>()
		const fingerprints = new Map<string, string>()
		const fingerprintOf = (shape: PersistedShape) =>
			Effect.gen(function* () {
				const cached = fingerprints.get(shape.id)
				if (cached !== undefined) {
					return cached
				}
				const computed = yield* schemaFingerprint(shape)
				fingerprints.set(shape.id, computed)
				return computed
			})
		for (const id of Object.keys(lock.retired)) {
			if (current.has(id)) {
				problems.push(
					`${id} is listed under "retired" in Persisted.lock.json, but a retired shape is active again. ` +
						`Give the new shape a different id, or remove the "retired" entry if the old values are readable.`,
				)
			}
		}
		for (const baseline of lock.baselines) {
			for (const [id, samples] of Object.entries(baseline.shapes)) {
				if (id in lock.retired) {
					continue
				}
				const shape = current.get(id)
				if (shape === undefined) {
					const view = parseViewShapeId(id)
					const running = view === null ? undefined : currentViews.get(view.name)
					if (view !== null && running !== undefined) {
						if (running > view.version) {
							continue
						}
						problems.push(
							`${id} shipped in baseline "${baseline.label}" and the view now runs at v${running}. ` +
								`A view's version only ever increases: rows written at v${view.version} are not rebuilt for an older version.`,
						)
						continue
					}
					problems.push(
						`${id} shipped in baseline "${baseline.label}" and nothing reads it now. ` +
							`Keep a schema for it, or list it under "retired" in Persisted.lock.json with the reason.`,
					)
					continue
				}
				const shipped = baseline.schemas[id]
				const fingerprint = shipped !== undefined ? yield* fingerprintOf(shape) : undefined
				if (shape.kind === "view" && shipped !== undefined && shipped !== fingerprint) {
					problems.push(
						`${id} changed since baseline "${baseline.label}" without a new version, so existing rows keep the old state.\n` +
							`  ${RULES.view}`,
					)
					continue
				}
				let unreadable = false
				for (const sample of samples) {
					const failure = yield* decodeFailure(shape, sample)
					if (failure === null) {
						continue
					}
					problems.push(
						`${id} can no longer read a value written by baseline "${baseline.label}": ${failure}\n` +
							`  ${RULES[shape.kind]}`,
					)
					unreadable = true
					break
				}
				if (
					!unreadable &&
					shipped !== undefined &&
					fingerprint !== undefined &&
					shipped !== fingerprint &&
					lock.reviewed[id]?.schema !== fingerprint &&
					!unreviewed.has(id)
				) {
					unreviewed.add(id)
					problems.push(
						`${id} changed since baseline "${baseline.label}" and the change has not been reviewed. ` +
							`Its samples still decode, which does not prove every stored value does.\n` +
							`  ${RULES[shape.kind]}\n` +
							`  Once checked, record it under "reviewed" in Persisted.lock.json as { "schema": "${fingerprint}", "reason": "..." }.`,
					)
				}
			}
		}
		return problems
	})

export const cutBaseline = (
	label: string,
	cutAt: string,
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): Effect.Effect<Baseline, PersistedLockError, Digest.Digest> =>
	Effect.gen(function* () {
		const entries = yield* Effect.forEach(shapes, (shape) =>
			Effect.all({
				fingerprint: schemaFingerprint(shape),
				samples: sampleEncoded(shape),
			}).pipe(Effect.map(({ fingerprint, samples }) => ({ id: shape.id, fingerprint, samples }))),
		)
		return decodeBaselineJson(
			JSON.stringify({
				label,
				cut_at: cutAt,
				schemas: Object.fromEntries(entries.map((entry) => [entry.id, entry.fingerprint])),
				shapes: Object.fromEntries(entries.map((entry) => [entry.id, entry.samples])),
			}),
		)
	})

export const readLockFile: Effect.Effect<
	PersistedLock,
	PersistedLockError,
	FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const file = yield* lockFilePath
	const content = yield* fs.readFileString(file).pipe(
		Effect.mapError(
			(error) =>
				new PersistedLockError({
					message: `Failed to read Persisted.lock.json: ${error.message}`,
				}),
		),
	)
	return yield* Schema.decodeEffect(PersistedLockJson)(content).pipe(
		Effect.mapError(
			(error) =>
				new PersistedLockError({
					message: `Persisted.lock.json is not a lock file: ${error.message}`,
				}),
		),
	)
})

export const writeLockFile = (
	lock: PersistedLock,
): Effect.Effect<void, PersistedLockError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const file = yield* lockFilePath
		const encoded = yield* Schema.encodeEffect(PersistedLockJson)(lock).pipe(
			Effect.mapError(
				(error) =>
					new PersistedLockError({
						message: `Failed to encode Persisted.lock.json: ${error.message}`,
					}),
			),
		)
		yield* fs.writeFileString(file, `${encoded}\n`).pipe(
			Effect.mapError(
				(error) =>
					new PersistedLockError({
						message: `Failed to write Persisted.lock.json: ${error.message}`,
					}),
			),
		)
	})

export const shipBlockers = (
	lock: PersistedLock,
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): Effect.Effect<ReadonlyArray<string>, PersistedLockError, Digest.Digest> =>
	Effect.gen(function* () {
		const problems = yield* lockProblems(lock, shapes)
		if (problems.length > 0) {
			return problems
		}
		const latest = lock.baselines.at(-1)
		if (latest === undefined) {
			return ["No baseline has been cut yet."]
		}
		const current = yield* cutBaseline(latest.label, latest.cut_at, shapes)
		const stored = decodeBaselineJson(JSON.stringify(current))
		return isDeepStrictEqual(latest.schemas, stored.schemas) &&
			isDeepStrictEqual(latest.shapes, stored.shapes)
			? []
			: [`Persisted shapes changed since "${latest.label}".`]
	})

const ManagedSource = Schema.Struct({
	revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
	baseline_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

export const matchesManagedBaseline = (
	source: unknown,
	bytes: Uint8Array,
): Effect.Effect<boolean, never, Digest.Digest> =>
	Effect.gen(function* () {
		const metadata = Schema.decodeUnknownOption(ManagedSource)(source)
		if (Option.isNone(metadata)) {
			return false
		}
		const digest = yield* Digest.Digest
		return (yield* digest.digestHex(Digest.sha256, bytes)) === metadata.value.baseline_sha256
	})

const lockIsCommitted: Effect.Effect<
	boolean,
	never,
	ChildProcessSpawner.ChildProcessSpawner | Path.Path | FileSystem.FileSystem | Digest.Digest
> = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const file = yield* lockFilePath.pipe(Effect.orElseSucceed(() => null))
	if (file === null) {
		return false
	}
	if (
		(yield* Config.String("CHECKFU_MANAGED_DEPLOYMENT").pipe(
			Config.withDefault("0"),
			Effect.orElseSucceed(() => "0"),
		)) === "1"
	) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		return yield* Effect.gen(function* () {
			const source = yield* fs.readFileString(
				path.resolve(path.dirname(file), "../../../../.checkfu/source.json"),
			)
			const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(ManagedSource))(source)
			return yield* matchesManagedBaseline(metadata, yield* fs.readFile(file))
		}).pipe(Effect.orElseSucceed(() => false))
	}
	const git = (...args: ReadonlyArray<string>) =>
		spawner
			.exitCode(
				ChildProcess.make("git", [...args, "--", file], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				}),
			)
			.pipe(
				Effect.map((code) => code === 0),
				Effect.orElseSucceed(() => false),
			)
	return (yield* git("ls-files", "--error-unmatch")) && (yield* git("diff", "--quiet", "HEAD"))
})

export const checkShippedBaseline: Effect.Effect<
	void,
	PersistedLockError,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Digest.Digest
> = Effect.gen(function* () {
	const lock = yield* readLockFile
	const blockers = [
		...(yield* shipBlockers(lock)),
		...((yield* lockIsCommitted) ? [] : ["Persisted.lock.json has uncommitted changes."]),
	]
	if (blockers.length > 0) {
		return yield* new PersistedLockError({
			message: `Production deploy refused:\n${blockers.map((blocker) => `  - ${blocker}`).join("\n")}\nRun \`bun run persisted:cut\`, commit Persisted.lock.json, then deploy.`,
		})
	}
})

export const requireShippedBaseline: Effect.Effect<void> = checkShippedBaseline.pipe(
	Effect.provide(PersistedServicesLive),
	Effect.orDie,
)
