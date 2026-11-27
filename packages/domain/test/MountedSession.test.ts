import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import { AgentId } from "../src/Agent/Agent.id.ts"
import { EnvironmentId } from "../src/Environment/Environment.id.ts"
import { MemoryStoreId } from "../src/Memory/MemoryStore.id.ts"
import {
	AdmitMountedSession,
	AdmitMountedSessionDecision,
} from "../src/Session/AdmitMountedSession.decision.ts"
import { SessionId } from "../src/Session/Session.id.ts"
import {
	SessionResourceId,
	fileMountPath,
	artifactMountPath,
	memoryMountPath,
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

const decision = AdmitMountedSessionDecision.definition
const context = { commandId: "mounted", now: DateTime.makeUnsafe(0) }
const session = {
	id: SessionId.make("sess_model"),
	state: { _tag: "Uninitialized" },
	record: (event: unknown) => event,
}
const agent = { id: AgentId.make("agent_mounted"), state: { status: "active", version: 1 } }
const environment = { id: EnvironmentId.make("env_mounted"), state: { status: "active" } }
const initialModes = [
	{ type: "idle" },
	{ type: "start", text: "Q" },
	{ type: "queue", plan: { count: 2, messages: '["Q","R"]' } },
] as const

it("checks the file and artifact predicates against the production decision in every admission mode", () => {
	const files = [fileMount("file_a", 7), fileMount("file_b", 11)] as const
	const artifacts = [artifactMount("art_a", 2), artifactMount("art_b", 3)] as const
	let checked = 0
	for (const initial of initialModes) {
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
			memoryStores: [],
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
							memoryStores: [],
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
								memoryStores: [],
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

it("checks two memory owners among file and artifact mounts in every admission mode", () => {
	const names = ["memory_a", "memory_b"] as const
	const mounts = names.map((id) => ({
		id: SessionResourceId.make(id),
		type: "memory_store" as const,
		memory_store_id: id,
		access: "read_write" as const,
		instructions: null,
		name: id,
		description: "",
		mount_path: memoryMountPath(id, id),
	}))
	const statuses = ["", "active", "archived", "deleted"] as const
	const file = fileMount("file_a", 7)
	const artifact = artifactMount("art_a", 2)
	const ownerStates = {
		files: [{ id: "file_a", state: { status: "ready", sha256: file.sha256, size: file.size } }],
		artifacts: [{ id: "art_a", state: { status: "active", version: artifact.version } }],
	}
	for (const initial of initialModes) {
		const command = new AdmitMountedSession({
			session_id: session.id,
			agent_id: agent.id,
			agent_version: null,
			environment_id: environment.id,
			mcp_server_credentials: "[]",
			title: null,
			resources: [file, ...mounts, artifact],
			initial,
		})
		expect(decision.keyOf(command).memoryStores).toEqual(names)
		for (const left of statuses) {
			for (const right of statuses) {
				const memoryStores = [
					{ id: MemoryStoreId.make(names[0]), state: { status: left } },
					{ id: MemoryStoreId.make(names[1]), state: { status: right } },
				]
				const before = {
					session: session.state,
					agent: agent.state,
					environment: environment.state,
					files: ownerStates.files.map(({ state }) => state),
					artifacts: ownerStates.artifacts.map(({ state }) => state),
					memoryStores: memoryStores.map(({ state }) => state),
				}
				const step = { before, command, events: [], after: before }
				const refused = memoryStores.find(({ state }) => state.status !== "active")
				expect(decision.transitions?.EveryMountedMemoryStoreIsActive?.(step)).toBe(
					refused === undefined,
				)
				const result = decision.decide(
					{ session, agent, environment, ...ownerStates, memoryStores },
					command,
					context,
				)
				if (refused === undefined) {
					expect(result).toMatchObject([
						{ _tag: "session.created" },
						...(initial.type === "start"
							? [{ _tag: "user.message" }, { _tag: "session.status_running" }]
							: []),
					])
					const missingRead = decision.decide(
						{ session, agent, environment, ...ownerStates, memoryStores: memoryStores.slice(0, 1) },
						command,
						context,
					)
					expect(missingRead).toMatchObject({
						_tag: "MemoryStoreNotFound",
						memory_store_id: names[1],
					})
					expect(
						decision.transitions?.EveryMountedMemoryStoreIsActive?.({
							...step,
							before: { ...before, memoryStores: before.memoryStores.slice(0, 1) },
						}),
					).toBe(false)
				} else {
					expect(result).toMatchObject({
						_tag:
							refused.state.status === "archived" ? "MemoryStoreArchived" : "MemoryStoreNotFound",
						memory_store_id: refused.id,
					})
				}
			}
		}
	}
})
