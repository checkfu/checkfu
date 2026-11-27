import * as Domain from "@alchemy.run/domain"
import * as Boolean from "effect/Boolean"
import * as Schema from "effect/Schema"
import { File } from "../../src/File/File.aggregate.ts"
import { FileNotFound } from "../../src/File/FileNotFound.rejection.ts"
import { Artifact } from "../../src/Artifact/Artifact.aggregate.ts"
import { ArtifactNotFound } from "../../src/Artifact/ArtifactNotFound.rejection.ts"
import { ArtifactVersionNotFound } from "../../src/Artifact/PublishArtifact.command.ts"
import { mountedRefusal, mountedKeys } from "../../src/Session/AdmissionMounts.ts"
import { FileMount, ArtifactMount, SkillMount } from "../../src/Session/SessionResource.ts"

export class MountAccepted extends Domain.Event("mount.accepted", {}) {}
export class RecordMount extends Domain.Command("RecordMount", {
	input: { id: Schema.String },
	events: [MountAccepted],
}) {}
export class MountCheck extends Domain.Aggregate("MountCheck", {
	id: Schema.String,
	state: Schema.Struct({ accepted: Schema.Boolean }),
	initial: { accepted: false },
	commands: [RecordMount],
	keyOf: (cmd) => cmd.id,
	decide: { RecordMount: () => [new MountAccepted()] },
	evolve: { "mount.accepted": () => ({ accepted: true }) },
}) {}

const rejects = [FileNotFound, ArtifactNotFound, ArtifactVersionNotFound] as const
export class CheckFile extends Domain.Command("CheckFile", {
	input: { resources: Schema.Array(FileMount) },
	events: [MountAccepted],
	rejects,
}) {}
export class CheckFileDecision extends Domain.Decision(CheckFile, {
	reads: { marker: MountCheck, files: File },
	keyOf: (cmd) => ({ marker: "check", files: mountedKeys(cmd.resources).files }),
	decide: ({ marker, files }, cmd) =>
		mountedRefusal(cmd.resources, files, []) ?? [marker.record(new MountAccepted())],
	transitions: {
		TheAcceptedFileIsReadyAndMatchesItsContent: ({ before, command }) =>
			Boolean.every([
				before.files.length === command.resources.length,
				before.files.every((file, index) =>
					Boolean.every([
						file.status === "ready",
						file.size === command.resources[index]?.size,
						file.sha256 === command.resources[index]?.sha256,
					]),
				),
			]),
	},
}) {}

export class CheckArtifact extends Domain.Command("CheckArtifact", {
	input: { resources: Schema.Tuple([Schema.Union([ArtifactMount, SkillMount])]) },
	events: [MountAccepted],
	rejects,
}) {}
export class CheckArtifactDecision extends Domain.Decision(CheckArtifact, {
	reads: { marker: MountCheck, artifacts: Artifact },
	keyOf: (cmd) => ({ marker: "check", artifacts: mountedKeys(cmd.resources).artifacts }),
	decide: ({ marker, artifacts }, cmd) =>
		mountedRefusal(cmd.resources, [], artifacts) ?? [marker.record(new MountAccepted())],
	transitions: {
		TheAcceptedArtifactIsActiveAtThePinnedVersion: ({ before, command }) =>
			Boolean.every([
				before.artifacts.length === command.resources.length,
				before.artifacts.every((artifact, index) =>
					Boolean.every([
						artifact.status === "active",
						(command.resources[index]?.version ?? 0) >= 1,
						(command.resources[index]?.version ?? 0) <= artifact.version,
					]),
				),
			]),
	},
}) {}
