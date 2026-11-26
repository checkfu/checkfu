import * as Domain from "@alchemy.run/domain"
import { versionedSnapshot } from "@checkfu/snapshots/VersionedSnapshot"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { MAX_AGENT_SYSTEM_LENGTH, NonNegativeInt } from "./SessionTypes.ts"

const ContextLength = NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_AGENT_SYSTEM_LENGTH))

export class SystemContextAppended extends Domain.Event("system_context.appended", {
	length: ContextLength,
}) {}

export class SystemContext extends Domain.Aggregate("SystemContext", {
	id: SessionId,
	state: versionedSnapshot({ current: 1, schema: Schema.Struct({ length: ContextLength }) }),
	initial: { length: 0 },
	events: [SystemContextAppended],
	invariants: {
		LengthStaysWithinCapacity: (state) => state.length <= MAX_AGENT_SYSTEM_LENGTH,
	},
	evolve: {
		"system_context.appended": (_state, event) => ({ length: event.length }),
	},
}) {}
