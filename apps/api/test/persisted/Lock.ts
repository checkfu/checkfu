import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type PersistedShape, RULES, parseViewShapeId, persistedShapes } from "./Shapes.ts"

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

export const LOCK_FILE_URL = new URL("./Persisted.lock.json", import.meta.url)

export const SAMPLES_PER_SHAPE = 8

const describeFailure = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause)

export const schemaFingerprint = (shape: PersistedShape): string =>
	createHash("sha256")
		.update(JSON.stringify(Schema.toJsonSchemaDocument(Schema.toCodecJson(shape.schema))))
		.digest("hex")

export const sampleEncoded = (
	shape: PersistedShape,
	count: number = SAMPLES_PER_SHAPE,
): Effect.Effect<ReadonlyArray<unknown>, string> =>
	Effect.gen(function* () {
		const arbitrary = yield* Effect.try({
			try: () => Arbitrary.schema(shape.schema),
			catch: (cause) => `${shape.id}: cannot generate values: ${describeFailure(cause)}`,
		})
		const values = yield* Arbitrary.sampleEffect(arbitrary, { count, seed: shape.id }).pipe(
			Effect.mapError(
				(error) => `${shape.id}: generated ${error.generated} of ${count} values before giving up`,
			),
		)
		const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(shape.schema))
		return yield* Effect.forEach(values, (value) =>
			encode(value).pipe(
				Effect.mapError((error) => `${shape.id}: has no JSON form: ${error.message}`),
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
): Effect.Effect<ReadonlyArray<string>> =>
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
				if (id in lock.retired) continue
				const shape = current.get(id)
				if (shape === undefined) {
					const view = parseViewShapeId(id)
					const running = view === null ? undefined : currentViews.get(view.name)
					if (view !== null && running !== undefined) {
						if (running > view.version) continue
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
				if (
					shape.kind === "view" &&
					shipped !== undefined &&
					shipped !== schemaFingerprint(shape)
				) {
					problems.push(
						`${id} changed since baseline "${baseline.label}" without a new version, so existing rows keep the old state.\n` +
							`  ${RULES.view}`,
					)
					continue
				}
				let unreadable = false
				for (const sample of samples) {
					const failure = yield* decodeFailure(shape, sample)
					if (failure === null) continue
					problems.push(
						`${id} can no longer read a value written by baseline "${baseline.label}": ${failure}\n` +
							`  ${RULES[shape.kind]}`,
					)
					unreadable = true
					break
				}
				const fingerprint = schemaFingerprint(shape)
				if (
					!unreadable &&
					shipped !== undefined &&
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
): Effect.Effect<Baseline, string> =>
	Effect.gen(function* () {
		const entries = yield* Effect.forEach(shapes, (shape) =>
			Effect.map(sampleEncoded(shape), (samples) => [shape.id, samples] as const),
		)
		return {
			label,
			cut_at: cutAt,
			schemas: Object.fromEntries(shapes.map((shape) => [shape.id, schemaFingerprint(shape)])),
			shapes: Object.fromEntries(entries),
		}
	})

export const decodeLock = (raw: unknown): Effect.Effect<PersistedLock, string> =>
	Schema.decodeUnknownEffect(PersistedLock)(raw).pipe(
		Effect.mapError((error) => `Persisted.lock.json is not a lock file: ${error.message}`),
	)

export const shipBlockers = (
	lock: PersistedLock,
	shapes: ReadonlyArray<PersistedShape> = persistedShapes,
): Effect.Effect<ReadonlyArray<string>, string> =>
	Effect.gen(function* () {
		const problems = yield* lockProblems(lock, shapes)
		if (problems.length > 0) return problems
		const latest = lock.baselines.at(-1)
		if (latest === undefined) return ["No baseline has been cut yet."]
		const current = yield* cutBaseline(latest.label, latest.cut_at, shapes)
		return isDeepStrictEqual(latest.schemas, current.schemas) &&
			isDeepStrictEqual(latest.shapes, JSON.parse(JSON.stringify(current.shapes)))
			? []
			: [`Persisted shapes changed since "${latest.label}".`]
	})

const lockIsCommitted = (): boolean => {
	const file = fileURLToPath(LOCK_FILE_URL)
	const git = (...args: ReadonlyArray<string>) =>
		spawnSync("git", [...args, "--", file], { stdio: "ignore" }).status === 0
	return git("ls-files", "--error-unmatch") && git("diff", "--quiet", "HEAD")
}

export const requireShippedBaseline = Effect.gen(function* () {
	const lock = yield* decodeLock(JSON.parse(readFileSync(LOCK_FILE_URL, "utf8")) as unknown)
	const blockers = [
		...(yield* shipBlockers(lock)),
		...(lockIsCommitted() ? [] : ["Persisted.lock.json has uncommitted changes."]),
	]
	if (blockers.length > 0) {
		return yield* Effect.fail(
			`Production deploy refused:\n${blockers.map((blocker) => `  - ${blocker}`).join("\n")}\nRun \`bun run persisted:cut\`, commit Persisted.lock.json, then deploy.`,
		)
	}
}).pipe(Effect.orDie)
