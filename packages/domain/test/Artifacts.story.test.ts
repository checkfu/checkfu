import * as Domain from "@alchemy.run/domain"
import { Story } from "@alchemy.run/domain/Story"
import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	AddArtifactVersion,
	ArtifactVersionAdded,
	ArtifactVersionConflict,
} from "../src/Artifact/AddArtifactVersion.command.ts"
import { Artifact } from "../src/Artifact/Artifact.aggregate.ts"
import { ArtifactNotFound } from "../src/Artifact/ArtifactNotFound.rejection.ts"
import {
	ArtifactVersionView,
	artifactVersionLookupKey,
} from "../src/Artifact/ArtifactVersionView.view.ts"
import { ArtifactView } from "../src/Artifact/ArtifactView.view.ts"
import {
	ArtifactAlreadyExists,
	ArtifactCreated,
	CreateArtifact,
} from "../src/Artifact/CreateArtifact.command.ts"
import { ArtifactWriteFenced } from "../src/Artifact/ArtifactWriteFenced.rejection.ts"
import { ArtifactDeleted, DeleteArtifact } from "../src/Artifact/DeleteArtifact.command.ts"
import {
	ArtifactWritesFenced,
	FenceArtifactWrites,
} from "../src/Artifact/FenceArtifactWrites.command.ts"
import { Artifacts } from "../src/Artifacts.model.ts"

const story = Story.make(Artifacts)

const t0 = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
const t1 = DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")
const t2 = DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")

const manifestA = "a".repeat(64)
const manifestB = "b".repeat(64)
const manifestC = "c".repeat(64)

describe("Artifacts", () => {
	it.effect("is well defined", () =>
		Effect.scoped(Layer.build(Artifacts.layer(Layer.empty))).pipe(Effect.provide(Domain.InMemory)),
	)

	it.effect("creates an artifact, adds a version and projects the head and each version", () => {
		const artifact = Artifact.ref("art_001")
		return story(
			Story.clock(t0),
			Story.state(artifact, { status: "", version: 0, name: "", manifest: "", fence: 0 }),
			Story.when(
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Report",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 1024,
					fence: 0,
				}),
			),
			Story.then(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Report",
					manifest: manifestA,
					file_count: 2,
					total_bytes: 1024,
				}),
			),
			Story.replied({ version: 1 }),
			Story.state(artifact, {
				status: "active",
				version: 1,
				name: "Report",
				manifest: manifestA,
				fence: 0,
				created_at: DateTime.toEpochMillis(t0),
				updated_at: DateTime.toEpochMillis(t0),
			}),
			Story.view(ArtifactView, artifact, {
				id: artifact.id,
				type: "artifact",
				name: "Report",
				version: 1,
				manifest: manifestA,
				file_count: 2,
				total_bytes: 1024,
				created_at: t0,
				updated_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 1,
				manifest: manifestA,
				file_count: 2,
				total_bytes: 1024,
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), Story.none),
			Story.clock(t1),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 1,
					manifest: manifestB,
					file_count: 3,
					total_bytes: 0,
					fence: 0,
				}),
			),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 3,
					total_bytes: 0,
				}),
			),
			Story.replied({ version: 2 }),
			Story.state(artifact, {
				status: "active",
				version: 2,
				name: "Report",
				manifest: manifestB,
				fence: 0,
				created_at: DateTime.toEpochMillis(t0),
				updated_at: DateTime.toEpochMillis(t1),
			}),
			Story.view(ArtifactView, artifact, {
				id: artifact.id,
				type: "artifact",
				name: "Report",
				version: 2,
				manifest: manifestB,
				file_count: 3,
				total_bytes: 0,
				created_at: t0,
				updated_at: t1,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 1,
				manifest: manifestA,
				file_count: 2,
				total_bytes: 1024,
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), {
				artifact_id: artifact.id,
				type: "artifact_version",
				version: 2,
				manifest: manifestB,
				file_count: 3,
				total_bytes: 0,
				created_at: t1,
			}),
		)
	})

	it.effect("keeps two artifacts' versions apart", () => {
		const first = Artifact.ref("art_first")
		const second = Artifact.ref("art_second")
		return story(
			Story.clock(t0),
			Story.given(
				first,
				new ArtifactCreated({
					version: 1,
					name: "First",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 10,
				}),
			),
			Story.given(
				second,
				new ArtifactCreated({
					version: 1,
					name: "Second",
					manifest: manifestB,
					file_count: 1,
					total_bytes: 20,
				}),
			),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(first.id, 1), {
				artifact_id: first.id,
				manifest: manifestA,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(second.id, 1), {
				artifact_id: second.id,
				manifest: manifestB,
			}),
		)
	})

	it.effect(
		"refuses a duplicate create, a stale version and anything on a missing artifact",
		() => {
			const missing = Artifact.ref("art_missing")
			const artifact = Artifact.ref("art_002")
			return story(
				Story.clock(t0),
				Story.when(
					new AddArtifactVersion({
						artifact_id: missing.id,
						expected_version: 1,
						manifest: manifestA,
						file_count: 1,
						total_bytes: 1,
						fence: 0,
					}),
				),
				Story.rejected(new ArtifactNotFound({ artifact_id: missing.id })),
				Story.when(new DeleteArtifact({ artifact_id: missing.id, fence: 0 })),
				Story.rejected(new ArtifactNotFound({ artifact_id: missing.id })),
				Story.state(missing, { status: "", version: 0, name: "", manifest: "", fence: 0 }),
				Story.view(ArtifactView, missing, Story.none),
				Story.given(
					artifact,
					new ArtifactCreated({
						version: 1,
						name: "Site",
						manifest: manifestA,
						file_count: 1,
						total_bytes: 12,
					}),
				),
				Story.when(
					new CreateArtifact({
						artifact_id: artifact.id,
						name: "Duplicate",
						manifest: manifestB,
						file_count: 1,
						total_bytes: 1,
						fence: 0,
					}),
				),
				Story.rejected(new ArtifactAlreadyExists({ artifact_id: artifact.id })),
				Story.when(
					new AddArtifactVersion({
						artifact_id: artifact.id,
						expected_version: 2,
						manifest: manifestB,
						file_count: 1,
						total_bytes: 1,
						fence: 0,
					}),
				),
				Story.rejected(
					new ArtifactVersionConflict({
						artifact_id: artifact.id,
						expected_version: 2,
						current_version: 1,
					}),
				),
				Story.state(artifact, {
					status: "active",
					version: 1,
					name: "Site",
					manifest: manifestA,
					fence: 0,
				}),
				Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), Story.none),
			)
		},
	)

	it.effect("deletes an artifact for good, keeping the versions it had", () => {
		const artifact = Artifact.ref("art_003")
		return story(
			Story.clock(t0),
			Story.given(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Draft",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 5,
				}),
			),
			Story.clock(t1),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 1,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 6,
					fence: 0,
				}),
			),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 6,
				}),
			),
			Story.replied({ version: 2 }),
			Story.clock(t2),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id, fence: 0 })),
			Story.then(artifact, new ArtifactDeleted()),
			Story.state(artifact, {
				status: "deleted",
				version: 2,
				name: "Draft",
				manifest: manifestB,
				fence: 0,
			}),
			Story.view(ArtifactView, artifact, Story.none),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 1), {
				artifact_id: artifact.id,
				version: 1,
				manifest: manifestA,
				created_at: t0,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), {
				artifact_id: artifact.id,
				version: 2,
				manifest: manifestB,
				created_at: t1,
			}),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id, fence: 0 })),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			Story.when(
				new AddArtifactVersion({
					artifact_id: artifact.id,
					expected_version: 2,
					manifest: manifestC,
					file_count: 1,
					total_bytes: 7,
					fence: 0,
				}),
			),
			Story.rejected(new ArtifactNotFound({ artifact_id: artifact.id })),
			Story.when(
				new CreateArtifact({
					artifact_id: artifact.id,
					name: "Resurrected",
					manifest: manifestC,
					file_count: 1,
					total_bytes: 7,
					fence: 0,
				}),
			),
			Story.rejected(new ArtifactAlreadyExists({ artifact_id: artifact.id })),
			Story.state(artifact, {
				status: "deleted",
				version: 2,
				name: "Draft",
				manifest: manifestB,
				fence: 0,
			}),
		)
	})

	it.effect("refuses writes and deletes that carry a fence the artifact has moved past", () => {
		const artifact = Artifact.ref("art_fenced")
		const create = (fence: number) =>
			new CreateArtifact({
				artifact_id: artifact.id,
				name: "Fenced",
				manifest: manifestA,
				file_count: 1,
				total_bytes: 1,
				fence,
			})
		const addVersion = (fence: number) =>
			new AddArtifactVersion({
				artifact_id: artifact.id,
				expected_version: 1,
				manifest: manifestB,
				file_count: 1,
				total_bytes: 2,
				fence,
			})
		return story(
			Story.clock(t0),
			Story.when(new FenceArtifactWrites({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactWritesFenced({ fence: 1 })),
			Story.replied({ fence: 1 }),
			Story.state(artifact, { status: "", version: 0, name: "", manifest: "", fence: 1 }),
			Story.view(ArtifactView, artifact, Story.none),
			Story.when(create(0)),
			Story.rejected(new ArtifactWriteFenced({ artifact_id: artifact.id })),
			Story.state(artifact, { status: "", version: 0, name: "", manifest: "", fence: 1 }),
			Story.when(create(1)),
			Story.then(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Fenced",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 1,
				}),
			),
			Story.replied({ version: 1 }),
			Story.state(artifact, {
				status: "active",
				version: 1,
				name: "Fenced",
				manifest: manifestA,
				fence: 1,
			}),
			Story.when(create(2)),
			Story.rejected(new ArtifactWriteFenced({ artifact_id: artifact.id })),
			Story.when(new FenceArtifactWrites({ artifact_id: artifact.id })),
			Story.then(artifact, new ArtifactWritesFenced({ fence: 2 })),
			Story.replied({ fence: 2 }),
			Story.view(ArtifactView, artifact, { version: 1, manifest: manifestA }),
			Story.when(addVersion(1)),
			Story.rejected(new ArtifactWriteFenced({ artifact_id: artifact.id })),
			Story.state(artifact, {
				status: "active",
				version: 1,
				name: "Fenced",
				manifest: manifestA,
				fence: 2,
			}),
			Story.view(ArtifactVersionView, artifactVersionLookupKey(artifact.id, 2), Story.none),
			Story.when(addVersion(2)),
			Story.then(
				artifact,
				new ArtifactVersionAdded({
					version: 2,
					manifest: manifestB,
					file_count: 1,
					total_bytes: 2,
				}),
			),
			Story.replied({ version: 2 }),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id, fence: 1 })),
			Story.rejected(new ArtifactWriteFenced({ artifact_id: artifact.id })),
			Story.state(artifact, {
				status: "active",
				version: 2,
				name: "Fenced",
				manifest: manifestB,
				fence: 2,
			}),
			Story.when(new DeleteArtifact({ artifact_id: artifact.id, fence: 2 })),
			Story.then(artifact, new ArtifactDeleted()),
		)
	})

	it.effect("records nothing when fencing a deleted artifact", () => {
		const artifact = Artifact.ref("art_fenced_deleted")
		return story(
			Story.clock(t0),
			Story.given(
				artifact,
				new ArtifactCreated({
					version: 1,
					name: "Gone",
					manifest: manifestA,
					file_count: 1,
					total_bytes: 1,
				}),
				new ArtifactWritesFenced({ fence: 1 }),
				new ArtifactDeleted(),
			),
			Story.when(new FenceArtifactWrites({ artifact_id: artifact.id })),
			Story.then(artifact),
			Story.replied({ fence: 1 }),
			Story.state(artifact, {
				status: "deleted",
				version: 1,
				name: "Gone",
				manifest: manifestA,
				fence: 1,
			}),
		)
	})
})
