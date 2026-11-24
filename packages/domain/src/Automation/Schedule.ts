import * as Arr from "effect/Array"
import * as Cron from "effect/Cron"
import * as DateTime from "effect/DateTime"
import * as Iterable from "effect/Iterable"
import * as Option from "effect/Option"

export const UPCOMING_FIRINGS = 5

const firings = Option.liftThrowable(
	(cron: Cron.Cron, after: number, count: number): ReadonlyArray<number> =>
		Arr.fromIterable(Iterable.take(Cron.sequence(cron, after), count)).map((at) => at.getTime()),
)

const hasADate = (expression: string): boolean =>
	Option.getSuccess(Cron.parse(expression, "UTC")).pipe(
		Option.flatMap((cron) => firings(cron, 0, 1)),
		Option.isSome,
	)

const namedZone = (timezone: string): Option.Option<DateTime.TimeZone> =>
	DateTime.zoneMakeNamed(timezone).pipe(
		Option.filter(
			() => !Option.exists(DateTime.zoneFromString(timezone), (zone) => zone._tag === "Offset"),
		),
	)

export const parseSchedule = (expression: string, timezone: string): Option.Option<Cron.Cron> =>
	namedZone(timezone).pipe(
		Option.flatMap((zone) => Option.getSuccess(Cron.parse(expression, zone))),
		Option.filter((cron) => cron.minutes.size === 1 && cron.seconds.size === 1),
		Option.filter(() => hasADate(expression)),
	)

export const isUsableSchedule = (expression: string, timezone: string): boolean =>
	Option.isSome(parseSchedule(expression, timezone))

export const upcomingOccurrences = (
	expression: string,
	timezone: string,
	after: number,
	count: number,
): ReadonlyArray<number> =>
	parseSchedule(expression, timezone).pipe(
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
