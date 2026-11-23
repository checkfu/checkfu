import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Result from "effect/Result"

import { HOURLY_CRON_EXPRESSION, NAMED_TIME_ZONE } from "./AutomationTypes.ts"

export const parseSchedule = (expression: string, timezone: string): Cron.Cron | null => {
	if (!HOURLY_CRON_EXPRESSION.test(expression) || !NAMED_TIME_ZONE.test(timezone)) {
		return null
	}
	const zone = DateTime.zoneMakeNamed(timezone)
	if (Option.isNone(zone)) {
		return null
	}
	try {
		const parsed = Cron.parse(expression, zone.value)
		return Result.isSuccess(parsed) ? parsed.success : null
	} catch {
		return null
	}
}

export const isUsableSchedule = (expression: string, timezone: string): boolean =>
	parseSchedule(expression, timezone) !== null

export const nextOccurrence = (
	expression: string,
	timezone: string,
	after: number,
): number | null => {
	const cron = parseSchedule(expression, timezone)
	if (cron === null) {
		return null
	}
	try {
		return Cron.next(cron, after).getTime()
	} catch {
		return null
	}
}

export const upcomingOccurrences = (
	expression: string,
	timezone: string,
	after: number,
	count: number,
): ReadonlyArray<number> => {
	const upcoming: Array<number> = []
	let from = after
	while (upcoming.length < count) {
		const next = nextOccurrence(expression, timezone, from)
		if (next === null) {
			break
		}
		upcoming.push(next)
		from = next
	}
	return upcoming
}
