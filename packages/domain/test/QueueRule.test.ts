import { startsQueuedTurn } from "@checkfu/sdk"
import { expect, it } from "vitest"
import { shouldDrainQueue } from "../src/Session/Session.aggregate.ts"
import { StopReason } from "../src/Session/SessionTypes.ts"

it.each(StopReason.fields.type.literals)("clients and the domain agree after %s", (type) => {
	const stopReason = { type }
	expect(startsQueuedTurn(type)).toBe(shouldDrainQueue(1, stopReason))
	expect(shouldDrainQueue(0, stopReason)).toBe(false)
})
