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
import { AutomationCapacityScope } from "./AutomationCapacityScope.ts"
import { present, reject } from "./HttpHelpers.ts"
import type { makeLister } from "./Listing.ts"

const inventoryUnavailable = "The automation inventory is changing. Run apply again."

const readAutomationSnapshot = (
	views: Effect.Success<typeof AutomationView>,
	id: string,
	unavailableMessage = `Automation ${id} projection is not ready.`,
) =>
	Effect.gen(function* () {
		const snapshot = yield* present(yield* views.get(Automation.ref(id)), 503, unavailableMessage)
		return {
			id: snapshot.id,
			revision: snapshot.revision,
			agent_id: AgentId.make(snapshot.agent_id),
			environment_id: EnvironmentId.make(snapshot.environment_id),
			archived_at: snapshot.archived_at,
		}
	})

export const withArchiveInventory = <A, E, R>(
	list: Effect.Success<typeof makeLister>,
	views: Effect.Success<typeof AutomationView>,
	send: (
		inventory: ReadonlyArray<AutomationReference>,
		scope: {
			readonly capacity_id: string
			readonly include_default_capacity?: true
		},
	) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const scope = yield* AutomationCapacityScope
		if (scope.archiveInventory !== undefined) {
			const ids = yield* scope.archiveInventory
			if (ids === null || ids.length > 2 * MAX_LIVE_AUTOMATIONS) {
				return yield* reject(503, inventoryUnavailable)
			}
			return {
				scope,
				inventory: yield* Effect.forEach(
					ids,
					(id) => readAutomationSnapshot(views, id, inventoryUnavailable),
					{ concurrency: 8 },
				),
			}
		}
		const page = yield* list("automation", { limit: MAX_LIVE_AUTOMATIONS }, (id) =>
			readAutomationSnapshot(views, id),
		)
		if (page.next_page !== null) {
			return yield* reject(503, inventoryUnavailable)
		}
		return { scope, inventory: page.data }
	}).pipe(
		Effect.flatMap(({ scope, inventory }) =>
			send(
				inventory.map(({ id, revision, agent_id, environment_id }) => ({
					id,
					revision,
					agent_id,
					environment_id,
				})),
				{
					capacity_id: scope.capacityId,
					...(scope.includeDefaultCapacity === true ? { include_default_capacity: true } : {}),
				},
			),
		),
		Effect.retry({
			while: Predicate.isTagged("AutomationInventoryChanged"),
			schedule: Schedule.spaced("200 millis"),
			times: 4,
		}),
		Effect.catchIf(Schema.is(AutomationDependencyInUse), (error) =>
			reject(409, `Automation ${error.automation_id} still references this resource.`),
		),
	)
