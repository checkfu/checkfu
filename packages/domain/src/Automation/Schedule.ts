import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Iterable from "effect/Iterable"
import * as Option from "effect/Option"

export const UPCOMING_FIRINGS = 5

const SPRING_FORWARD_LOOKBACK_MILLIS = 3 * 60 * 60 * 1000

const firings = Option.liftThrowable(
	(cron: Cron.Cron, after: number, count: number): ReadonlyArray<number> =>
		Number.isSafeInteger(count) && count >= 1
			? Array.from(
					Iterable.take(
						Iterable.filter(
							Cron.sequence(cron, after - SPRING_FORWARD_LOOKBACK_MILLIS),
							(at) => at.getTime() > after,
						),
						count,
					),
					(at) => at.getTime(),
				)
			: [],
)

const UTC = DateTime.zoneMakeNamedUnsafe("UTC")

const hasADate = (expression: string): boolean =>
	Option.getSuccess(Cron.parse(expression, UTC)).pipe(
		Option.flatMap((cron) => firings(cron, 0, 1)),
		Option.isSome,
	)

const isOffset = (zone: DateTime.TimeZone.Named): boolean =>
	Option.exists(
		DateTime.zoneFromString(
			new Intl.DateTimeFormat("en-US", { timeZone: zone.id }).resolvedOptions().timeZone,
		),
		DateTime.isTimeZoneOffset,
	)

const parseInZone = (expression: string, timezone: string): Option.Option<Cron.Cron> =>
	DateTime.zoneMakeNamed(timezone).pipe(
		Option.filter((zone) => !isOffset(zone)),
		Option.flatMap((zone) => Option.getSuccess(Cron.parse(expression, zone))),
		Option.filter((cron) => cron.minutes.size === 1 && cron.seconds.size === 1),
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
		Option.flatMap((cron) => firings(cron, after, count)),
		Option.getOrElse((): ReadonlyArray<number> => []),
	)

export const firingsAhead = (upcoming: ReadonlyArray<number>, now: number): ReadonlyArray<number> =>
	upcoming.filter((at, index) => index === 0 || at > Math.max(upcoming[0] ?? at, now))

export const nextOccurrence = (
	expression: string,
	timezone: string,
	after: number,
): number | null => upcomingOccurrences(expression, timezone, after, 1)[0] ?? null
