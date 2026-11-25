import { describe, expect, it } from "@effect/vitest"
import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import { upcomingOccurrences } from "../src/Automation/Schedule.ts"

const chain = (next: (from: number) => number | undefined, from: string, count: number) => {
	const found: Array<string> = []
	let at = Date.parse(from)
	while (found.length < count) {
		const following = next(at)
		if (following === undefined) {
			break
		}
		found.push(new Date(following).toISOString())
		at = following
	}
	return found
}

describe("schedule firings", () => {
	it("match Effect's own search in the zone, across daylight-saving changes of an hour, half an hour and 45 minutes", () => {
		const zones = ["America/New_York", "Australia/Lord_Howe", "Pacific/Chatham", "Europe/London"]
		const expressions = ["15 2 * * *", "30 1 * * *", "45 * * * *", "0 2 * 3 0", "0 9 * * 1-5"]
		const anchors = ["2026-03-07T12:00:00Z", "2026-03-29T00:30:00Z", "2026-10-03T13:00:00Z"]
		for (const timezone of zones) {
			const zone = DateTime.zoneMakeNamedUnsafe(timezone)
			for (const expression of expressions) {
				const cron = Cron.parseUnsafe(expression, zone)
				for (const anchor of anchors) {
					const effect = chain((from) => Cron.next(cron, from).getTime(), anchor, 20)
					const ours = chain(
						(from) => upcomingOccurrences(expression, timezone, from, 1)[0],
						anchor,
						20,
					)
					expect([timezone, expression, anchor, ours]).toEqual([
						timezone,
						expression,
						anchor,
						effect,
					])
					const atOnce = upcomingOccurrences(expression, timezone, Date.parse(anchor), 20).map(
						(at) => new Date(at).toISOString(),
					)
					expect([timezone, expression, anchor, atOnce]).toEqual([
						timezone,
						expression,
						anchor,
						effect,
					])
				}
			}
		}
	})

	it("still lists a firing that a daylight-saving gap moved past the starting point", () => {
		const ny = DateTime.zoneMakeNamedUnsafe("America/New_York")
		const from = Date.parse("2026-03-08T07:05:00Z")
		expect(
			new Date(Cron.next(Cron.parseUnsafe("15 2 * * *", ny), from).getTime()).toISOString(),
		).toBe("2026-03-09T06:15:00.000Z")
		expect(
			upcomingOccurrences("15 2 * * *", "America/New_York", from, 2).map((at) =>
				new Date(at).toISOString(),
			),
		).toEqual(["2026-03-08T07:15:00.000Z", "2026-03-09T06:15:00.000Z"])
	})

	it("returns no firings for a count that is not a positive whole number, without searching", () => {
		for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect([count, upcomingOccurrences("0 9 * * *", "UTC", 0, count)]).toEqual([count, []])
		}
		expect(upcomingOccurrences("0 9 * * *", "UTC", 0, 2)).toHaveLength(2)
	})

	it("finds a sparse schedule's firings in the zone without a long search", () => {
		const firings = upcomingOccurrences(
			"59 23 29 2 */7",
			"America/New_York",
			Date.parse("2026-01-01T00:00:00Z"),
			5,
		).map((at) => new Date(at).toISOString())
		expect(firings).toEqual([
			"2032-03-01T04:59:00.000Z",
			"2060-03-01T04:59:00.000Z",
			"2088-03-01T04:59:00.000Z",
			"2128-03-01T04:59:00.000Z",
			"2156-03-01T04:59:00.000Z",
		])
		const ny = DateTime.zoneMakeNamedUnsafe("America/New_York")
		expect(
			chain(
				(from) => Cron.next(Cron.parseUnsafe("59 23 29 2 */7", ny), from).getTime(),
				"2026-01-01T00:00:00Z",
				2,
			),
		).toEqual(firings.slice(0, 2))
	})
})
