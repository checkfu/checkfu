import * as Domain from "@alchemy.run/domain"
import { Artifact } from "./Artifact/Artifact.aggregate.ts"
import { ArtifactVersionView } from "./Artifact/ArtifactVersionView.view.ts"

export class Artifacts extends Domain.Model("Artifacts", {
	aggregates: [Artifact],
	views: [ArtifactVersionView],
	invariants: {
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
		"ReserveArtifact",
		"ExpireArtifactReservation",
		"CreateArtifact",
		"AddArtifactVersion",
		"DeleteArtifact",
		"PublishArtifact",
		"UnpublishArtifact",
		"ClaimArtifactIdempotencyKey",
	],
	views: ["ArtifactVersionView"],
}) {}
