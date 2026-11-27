import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import {
	AdmitMountedSession,
	AdmitMountedSessionDecision,
} from "../src/Session/AdmitMountedSession.decision.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import {
	SessionResourceId,
	fileMountPath,
	artifactMountPath,
} from "../src/Session/SessionResource.ts"

const fileMount = (id: string, size: number) => ({
	type: "file" as const,
	file_id: id,
	size,
	sha256: id,
	id: SessionResourceId.make(id),
	mount_path: fileMountPath(id),
})
const artifactMount = (id: string, version: number) => ({
	type: "artifact" as const,
	artifact_id: id,
	version,
	name: id,
	manifest: "manifest",
	id: SessionResourceId.make(id),
	mount_path: artifactMountPath(id, id),
})
const fileCases = (id: string, size: number) => [
	{ status: "ready", size, sha256: id },
	{ status: "", size: 0, sha256: "" },
	{ status: "deleted", size, sha256: id },
	{ status: "ready", size: size + 1, sha256: id },
	{ status: "ready", size, sha256: "wrong" },
]
const artifactCases = (pin: number) => [
	{ status: "active", version: pin },
	{ status: "active", version: pin + 1 },
	{ status: "", version: 0 },
	{ status: "deleted", version: pin },
	{ status: "active", version: pin - 1 },
]

it("checks both transition predicates and the production decision for every combination of two file and two artifact cases", () => {
	const decision = AdmitMountedSessionDecision.definition
	const context = { commandId: "mounted", now: DateTime.makeUnsafe(0) }
	const session = {
		id: SessionId.make("sess_model"),
		state: { _tag: "Uninitialized" },
		record: (event: unknown) => event,
	}
	const agent = { id: AgentId.make("agent_mounted"), state: { status: "active", version: 1 } }
	const environment = { id: EnvironmentId.make("env_mounted"), state: { status: "active" } }
	const files = [fileMount("file_a", 7), fileMount("file_b", 11)] as const
	const artifacts = [artifactMount("art_a", 2), artifactMount("art_b", 3)] as const
	let checked = 0
	for (const initial of [
		{ type: "idle" },
		{ type: "start", text: "Q" },
		{ type: "queue", plan: { count: 2, messages: '["Q","R"]' } },
	] as const) {
		const command = new AdmitMountedSession({
			session_id: session.id,
			agent_id: agent.id,
			agent_version: null,
			environment_id: environment.id,
			mcp_server_credentials: "[]",
			title: null,
			resources: [artifacts[0], files[0], files[1], artifacts[1]],
			initial,
		})
		expect(decision.keyOf(command)).toEqual({
			session: session.id,
			agent: agent.id,
			environment: environment.id,
			files: ["file_a", "file_b"],
			artifacts: ["art_a", "art_b"],
		})
		for (const [fileA, first] of fileCases("file_a", 7).entries()) {
			for (const [fileB, second] of fileCases("file_b", 11).entries()) {
				for (const [artifactA, left] of artifactCases(2).entries()) {
					for (const [artifactB, right] of artifactCases(3).entries()) {
						const before = {
							session: session.state,
							agent: agent.state,
							environment: environment.state,
							files: [first, second],
							artifacts: [left, right],
						}
						const result = decision.decide(
							{
								session,
								agent,
								environment,
								files: [
									{ id: "file_a", state: first },
									{ id: "file_b", state: second },
								],
								artifacts: [
									{ id: "art_a", state: left },
									{ id: "art_b", state: right },
								],
							},
							command,
							context,
						)
						const filesValid = fileA === 0 && fileB === 0
						const artifactsValid = artifactA < 2 && artifactB < 2
						const step = { before, command, events: [], after: before }
						expect(decision.transitions?.EveryMountedFileIsReadyAndMatchesItsContent?.(step)).toBe(
							filesValid,
						)
						expect(
							decision.transitions?.EveryMountedArtifactIsActiveAtThePinnedVersion?.(step),
						).toBe(artifactsValid)
						if (filesValid && artifactsValid) {
							expect(result).toEqual(
								expect.arrayContaining([
									expect.objectContaining({
										_tag: "session.created",
										resources: command.resources,
									}),
								]),
							)
						} else {
							const missing = [artifactA, artifactB].some((index) => index === 2 || index === 3)
							expect(result).toMatchObject({
								_tag: !filesValid
									? "FileNotFound"
									: missing
										? "ArtifactNotFound"
										: "ArtifactVersionNotFound",
							})
						}
						checked += 1
					}
				}
			}
		}
	}
	expect(checked).toBe(1875)
})
