import { ArtifactId } from "@checkfu/domain/Artifact/Artifact.id"
import { ArtifactBytes } from "@checkfu/domain/Artifact/ArtifactBytes.external"
import { describe, expect, it } from "@effect/vitest"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { ArtifactDatabase, ArtifactDatabaseError } from "../src/ArtifactData/ArtifactDatabase.ts"
import { makeArtifactDatabaseMemory } from "../src/ArtifactData/ArtifactDatabaseMemory.ts"
import { ArtifactBytesLive } from "../src/Artifacts/ArtifactBytesLive.ts"
import { ArtifactStore } from "../src/Artifacts/ArtifactStore.ts"
import { makeArtifactStoreMemory } from "../src/Artifacts/ArtifactStoreMemory.ts"
import { TEST_RUNTIME } from "./helpers/ApiHarness.ts"

const ID = ArtifactId.make("art_000000000000000000000001")

describe("Purging a deleted artifact", () => {
	it.effect("erases its documents and removes its files", () => {
		const database = makeArtifactDatabaseMemory()
		const store = makeArtifactStoreMemory()
		return Effect.gen(function* () {
			const documents = yield* ArtifactDatabase
			yield* documents.write(ID, "notes", "a", '"kept until deleted"', "create")
			yield* (yield* ArtifactBytes).purge({ artifact_id: ID })
			expect(yield* documents.get(ID, "notes", "a")).toBeNull()
			expect(yield* documents.write(ID, "notes", "a", '"late"', "create")).toEqual({
				refused: "erased",
			})
		}).pipe(
			Effect.provideService(RuntimeContext, TEST_RUNTIME),
			Effect.provide(
				ArtifactBytesLive.pipe(Layer.provideMerge(database.layer), Layer.provideMerge(store.layer)),
			),
		)
	})

	it.effect(
		"still removes its files when the database cannot be reached, and reports the failure",
		() => {
			const purged: Array<string> = []
			return Effect.gen(function* () {
				const outcome = yield* Effect.exit((yield* ArtifactBytes).purge({ artifact_id: ID }))
				expect(Exit.isFailure(outcome)).toBe(true)
				expect(purged).toEqual([ID])
			}).pipe(
				Effect.provideService(RuntimeContext, TEST_RUNTIME),
				Effect.provide(
					ArtifactBytesLive.pipe(
						Layer.provide(
							Layer.effect(
								ArtifactStore,
								Effect.map(ArtifactStore, (real) => ({
									...real,
									purge: (artifactId: string) =>
										Effect.sync(() => {
											purged.push(artifactId)
										}),
								})).pipe(Effect.provide(makeArtifactStoreMemory().layer)),
							),
						),
						Layer.provide(
							Layer.effect(
								ArtifactDatabase,
								Effect.map(ArtifactDatabase, (real) => ({
									...real,
									erase: () => Effect.fail(new ArtifactDatabaseError({ cause: "unreachable" })),
								})).pipe(Effect.provide(makeArtifactDatabaseMemory().layer)),
							),
						),
					),
				),
			)
		},
	)
})
