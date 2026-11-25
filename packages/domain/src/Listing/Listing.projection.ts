import * as Domain from "@alchemy.run/domain"
import type * as Projection from "@alchemy.run/domain/Projection"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Agent } from "../Agent/Agent.aggregate.ts"
import { AgentArchived } from "../Agent/ArchiveAgent.command.ts"
import { AgentCreated } from "../Agent/CreateAgent.command.ts"
import { EnvironmentArchived } from "../Environment/ArchiveEnvironment.command.ts"
import { EnvironmentCreated } from "../Environment/CreateEnvironment.command.ts"
import { EnvironmentDeleted } from "../Environment/DeleteEnvironment.command.ts"
import { Environment } from "../Environment/Environment.aggregate.ts"
import { SessionArchived } from "../Session/ArchiveSession.command.ts"
import { SessionCreated } from "../Session/CreateSession.command.ts"
import { MemoryStoreArchived } from "../Memory/ArchiveMemoryStore.command.ts"
import { MemoryStoreCreated } from "../Memory/CreateMemoryStore.command.ts"
import { MemoryStoreDeleted } from "../Memory/DeleteMemoryStore.command.ts"
import { MemoryStore } from "../Memory/MemoryStore.aggregate.ts"
import { Session } from "../Session/Session.aggregate.ts"
import { ARCHIVED, DELETED, LISTED, ListingStore } from "./ListingStore.ts"
import type { ListingChange } from "./ListingStore.ts"

export class Listing extends Domain.Projection(
	"Listing",
	{
		from: [Agent, Environment, Session, MemoryStore],
		key: Schema.String,
		keyOf: {
			Agent: ({ source }) => source.id,
			Environment: ({ source }) => source.id,
			Session: ({ source }) => source.id,
			MemoryStore: ({ source }) => source.id,
		},
		on: [
			AgentCreated,
			AgentArchived,
			EnvironmentCreated,
			EnvironmentArchived,
			EnvironmentDeleted,
			SessionCreated,
			SessionArchived,
			MemoryStoreCreated,
			MemoryStoreArchived,
			MemoryStoreDeleted,
		],
	},
	{
		description:
			"Every agent, environment, session and memory store, in creation order, with its status.",
	},
) {}

const changeOf = ({
	key: id,
	event,
	envelope,
}: Projection.InputOf<typeof Listing>): ListingChange => {
	const created_at = DateTime.toEpochMillis(envelope.at)
	switch (event._tag) {
		case "agent.created":
			return { kind: "agent", id, created_at, agent_id: null, status: LISTED }
		case "agent.archived":
			return { kind: "agent", id, created_at, agent_id: null, status: ARCHIVED }
		case "environment.created":
			return { kind: "environment", id, created_at, agent_id: null, status: LISTED }
		case "environment.archived":
			return { kind: "environment", id, created_at, agent_id: null, status: ARCHIVED }
		case "environment.deleted":
			return { kind: "environment", id, created_at, agent_id: null, status: DELETED }
		case "session.created":
			return { kind: "session", id, created_at, agent_id: event.agent_id, status: LISTED }
		case "session.archived":
			return { kind: "session", id, created_at, agent_id: null, status: ARCHIVED }
		case "memory_store.created":
			return { kind: "memory_store", id, created_at, agent_id: null, status: LISTED }
		case "memory_store.archived":
			return { kind: "memory_store", id, created_at, agent_id: null, status: ARCHIVED }
		case "memory_store.deleted":
			return { kind: "memory_store", id, created_at, agent_id: null, status: DELETED }
	}
}

export const ListingLive = Listing.toLayer(
	Effect.gen(function* () {
		const store = yield* ListingStore
		return (batch) => store.record(batch.map(changeOf))
	}),
	{ batch: { size: 100 } },
)
