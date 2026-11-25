import * as Domain from "@alchemy.run/domain"
import { Artifact } from "./Artifact/Artifact.aggregate.ts"
import { ArtifactVersionView } from "./Artifact/ArtifactVersionView.view.ts"
import { ArtifactView } from "./Artifact/ArtifactView.view.ts"

export class Artifacts extends Domain.Model("Artifacts", {
	aggregates: [Artifact],
	views: [ArtifactView, ArtifactVersionView],
	invariants: {
		ArtifactViewMatchesArtifact: (m) =>
			[
				m.Artifact.every((a) => {
					const view = m.ArtifactView.find((v) => v.id === a.id)
					if (a.state.status === "" || a.state.status === "deleted") {
						return view === undefined
					}
					if (view === undefined) {
						return false
					}
					return [
						view.state.id === a.id,
						view.state.version === a.state.version,
						view.state.name === a.state.name,
						view.state.manifest === a.state.manifest,
					].every((ok) => ok)
				}),
				m.ArtifactView.every((v) =>
					m.Artifact.some((a) => [a.id === v.id, a.state.status === "active"].every((ok) => ok)),
				),
			].every((ok) => ok),
		EveryArtifactVersionIsWithinItsArtifactsHead: (m) =>
			m.ArtifactVersionView.every((v) =>
				m.Artifact.some((a) =>
					[
						a.id === v.state.artifact_id,
						v.id === `${a.id}@${v.state.version}`,
						a.state.status !== "",
						v.state.version <= a.state.version,
						v.state.version !== a.state.version || v.state.manifest === a.state.manifest,
					].every((ok) => ok),
				),
			),
		EveryArtifactVersionIsRecorded: (m) =>
			m.Artifact.every(
				(a) =>
					m.ArtifactVersionView.filter((v) => v.state.artifact_id === a.id).length ===
					a.state.version,
			),
	},
	sometimes: {
		AnArtifactGainsASecondVersion: (m) =>
			m.Artifact.some((a) => [a.state.status === "active", a.state.version >= 2].every((ok) => ok)),
		AnArtifactIsDeleted: (m) => m.Artifact.some((a) => a.state.status === "deleted"),
		AnArtifactIsPublished: (m) => m.Artifact.some((a) => a.state.publication_token !== ""),
	},
}) {}

export class ArtifactsApi extends Domain.Api("ArtifactsApi", {
	model: Artifacts,
	commands: [
		"CreateArtifact",
		"AddArtifactVersion",
		"DeleteArtifact",
		"FenceArtifactWrites",
		"PublishArtifact",
		"UnpublishArtifact",
		"ClaimArtifactIdempotencyKey",
	],
	views: ["ArtifactView", "ArtifactVersionView"],
}) {}
