import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"

export const UPCOMING_FIRINGS = 5

const LOOKBACK_MILLIS = 3 * 60 * 60 * 1000

const firings = Option.liftThrowable(
	(
		cron: Cron.Cron,
		zone: DateTime.TimeZone,
		after: number,
		count: number,
	): ReadonlyArray<number> => {
		const found: Array<number> = []
		if (!Number.isSafeInteger(count) || count < 1) {
			return found
		}
		const wallClockAfter =
			after + DateTime.zonedOffset(DateTime.makeZonedUnsafe(after, { timeZone: zone }))
		for (const wallClock of Cron.sequence(cron, wallClockAfter - LOOKBACK_MILLIS)) {
			const at = DateTime.toEpochMillis(
				DateTime.makeZonedUnsafe(wallClock, { timeZone: zone, adjustForTimeZone: true }),
			)
			if (at > Math.max(after, found.at(-1) ?? after)) {
				found.push(at)
			}
			if (found.length === count) {
				return found
			}
		}
		return found
	},
)

const utc = (): DateTime.TimeZone.Named => DateTime.zoneMakeNamedUnsafe("UTC")

const hasADate = (expression: string): boolean =>
	Option.getSuccess(Cron.parse(expression, utc())).pipe(
		Option.flatMap((cron) => firings(cron, utc(), 0, 1)),
		Option.isSome,
	)

const offsets = new WeakMap<DateTime.TimeZone.Named, boolean>()

const isOffset = (zone: DateTime.TimeZone.Named): boolean => {
	const known = offsets.get(zone)
	if (known !== undefined) {
		return known
	}
	const offset = Option.exists(
		DateTime.zoneFromString(
			new Intl.DateTimeFormat("en-US", { timeZone: zone.id }).resolvedOptions().timeZone,
		),
		DateTime.isTimeZoneOffset,
	)
	offsets.set(zone, offset)
	return offset
}

const parseInZone = (
	expression: string,
	timezone: string,
): Option.Option<readonly [Cron.Cron, DateTime.TimeZone.Named]> =>
	DateTime.zoneMakeNamed(timezone).pipe(
		Option.filter((zone) => !isOffset(zone)),
		Option.flatMap((zone) =>
			Option.getSuccess(Cron.parse(expression, utc())).pipe(
				Option.map((cron) => [cron, zone] as const),
			),
		),
		Option.filter(([cron]) => cron.minutes.size === 1 && cron.seconds.size === 1),
		Option.filter(() => hasADate(expression)),
	)

export const sameSchedule = (
	a: { readonly expression: string; readonly timezone: string },
	b: { readonly expression: string; readonly timezone: string },
): boolean => a.expression === b.expression && a.timezone === b.timezone

export const isUsableSchedule = (expression: string, timezone: string): boolean =>
	Option.isSome(parseInZone(expression, timezone))

export const upcomingOccurrences = (
	expression: string,
	timezone: string,
	after: number,
	count: number,
): ReadonlyArray<number> =>
	parseInZone(expression, timezone).pipe(
		Option.flatMap(([cron, zone]) => firings(cron, zone, after, count)),
		Option.getOrElse((): ReadonlyArray<number> => []),
	)

export const firingsAhead = (upcoming: ReadonlyArray<number>, now: number): ReadonlyArray<number> =>
	upcoming.filter((at, index) => index === 0 || at > Math.max(upcoming[0] ?? at, now))

export const nextOccurrence = (
	expression: string,
	timezone: string,
	after: number,
): number | null => upcomingOccurrences(expression, timezone, after, 1)[0] ?? null
