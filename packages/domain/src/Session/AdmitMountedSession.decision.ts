import * as Domain from "@alchemy.run/domain"
import * as Boolean from "effect/Boolean"
import * as Schema from "effect/Schema"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { File } from "../File/File.aggregate.ts"
import { FileId } from "../File/File.id.ts"
import { FileNotFound } from "../File/FileNotFound.rejection.ts"
import { admissionFields, admissionRejections } from "./AdmitSession.command.ts"
import { admissionRefusal } from "./AdmissionRefusal.ts"
import { SessionAlreadyExists, SessionCreated } from "./CreateSession.command.ts"
import { InitialMessages } from "./InitialMessages.ts"
import { SessionStatusRunning, UserMessage } from "./SendUserMessage.command.ts"
import { Session } from "./Session.aggregate.ts"
import { SessionResources, filesOf } from "./SessionResource.ts"
import { MessageText } from "./SessionTypes.ts"

export class AdmitMountedSession extends Domain.Command("AdmitMountedSession", {
	input: {
		...admissionFields,
		resources: SessionResources,
		initial: Schema.Union([
			Schema.Struct({ type: Schema.Literal("idle") }),
			Schema.Struct({ type: Schema.Literal("start"), text: MessageText }),
			Schema.Struct({ type: Schema.Literal("queue"), plan: InitialMessages }),
		]),
	},
	events: [SessionCreated, UserMessage, SessionStatusRunning],
	rejects: [...admissionRejections, FileNotFound],
}) {}

export class AdmitMountedSessionDecision extends Domain.Decision(AdmitMountedSession, {
	reads: {
		session: Session,
		agent: Agent,
		environment: Environment,
		files: File,
	},
	keyOf: (cmd) => ({
		session: cmd.session_id,
		agent: cmd.agent_id,
		environment: cmd.environment_id,
		files: filesOf(cmd.resources).map((file) => FileId.make(file.file_id)),
	}),
	decide: ({ session, agent, environment, files }, cmd) => {
		if (session.state._tag !== "Uninitialized") {
			return new SessionAlreadyExists({ session_id: session.id })
		}
		const pinned = cmd.agent_version ?? agent.state.version
		const refused = admissionRefusal(agent, environment, pinned)
		if (refused !== undefined) {
			return refused
		}
		const invalidFile = filesOf(cmd.resources).find(
			(mount) =>
				!files.some((file) =>
					Boolean.every([
						file.id === mount.file_id,
						file.state.status === "ready",
						file.state.sha256 === mount.sha256,
						file.state.size === mount.size,
					]),
				),
		)
		if (invalidFile !== undefined) {
			return new FileNotFound({ file_id: FileId.make(invalidFile.file_id) })
		}
		const created = session.record(
			new SessionCreated({
				agent_id: agent.id,
				agent_version: pinned,
				environment_id: environment.id,
				title: cmd.title,
				mcp_server_credentials: cmd.mcp_server_credentials,
				resources: cmd.resources,
				...(cmd.initial.type === "queue" ? { initial_messages: cmd.initial.plan } : {}),
			}),
		)
		return cmd.initial.type === "start"
			? [
					created,
					session.record(new UserMessage({ content: [{ type: "text", text: cmd.initial.text }] })),
					session.record(new SessionStatusRunning({ turn: 1 })),
				]
			: [created]
	},
	transitions: {
		EveryMountedFileIsReadyAndMatchesItsContent: ({ before, command }) => {
			const mounts = filesOf(command.resources)
			return (
				before.files.length === mounts.length &&
				before.files.every((file, index) => {
					const mount = mounts[index]
					return (
						mount !== undefined &&
						file.status === "ready" &&
						file.size === mount.size &&
						file.sha256 === mount.sha256
					)
				})
			)
		},
	},
}) {}
