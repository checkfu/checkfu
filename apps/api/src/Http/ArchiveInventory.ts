import { AgentId } from "@checkfu/domain/Agent/Agent.id"
import { Automation } from "@checkfu/domain/Automation/Automation.aggregate"
import type { AutomationView } from "@checkfu/domain/Automation/AutomationView.view"
import { MAX_LIVE_AUTOMATIONS } from "@checkfu/domain/Automation/AutomationCapacity.aggregate"
import { AutomationDependencyInUse } from "@checkfu/domain/Automation/GuardedArchives"
import type { AutomationReference } from "@checkfu/domain/Automation/GuardedArchives"
import { EnvironmentId } from "@checkfu/domain/Environment/Environment.id"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { present, reject } from "./HttpHelpers.ts"
import type { makeLister } from "./Listing.ts"

export const withArchiveInventory = <A, E, R>(
	list: Effect.Success<typeof makeLister>,
	views: Effect.Success<typeof AutomationView>,
	send: (inventory: ReadonlyArray<AutomationReference>) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const page = yield* list("automation", { limit: MAX_LIVE_AUTOMATIONS }, (id) =>
			Effect.gen(function* () {
				const snapshot = yield* present(
					yield* views.get(Automation.ref(id)),
					503,
					`Automation ${id} projection is not ready.`,
				)
				return {
					id: snapshot.id,
					revision: snapshot.revision,
					agent_id: AgentId.make(snapshot.agent_id),
					environment_id: EnvironmentId.make(snapshot.environment_id),
					archived_at: snapshot.archived_at,
				}
			}),
		)
		if (page.next_page !== null) {
			return yield* reject(503, "The automation inventory is changing. Run apply again.")
		}
		const inventory: ReadonlyArray<AutomationReference> = page.data
		return inventory.map(({ id, revision, agent_id, environment_id }) => ({
			id,
			revision,
			agent_id,
			environment_id,
		}))
	}).pipe(
		Effect.flatMap(send),
		Effect.retry({
			while: Predicate.isTagged("AutomationInventoryChanged"),
			schedule: Schedule.spaced("200 millis"),
			times: 4,
		}),
		Effect.catchIf(Schema.is(AutomationDependencyInUse), (error) =>
			reject(409, `Automation ${error.automation_id} still references this resource.`),
		),
	)
