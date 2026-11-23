import * as Schema from "effect/Schema"

export {
	AutomationName,
	AutomationRunError,
	AutomationSchedule,
	AutomationTrigger,
	CronExpression,
	HOURLY_CRON_EXPRESSION,
	MAX_AUTOMATION_ID_LENGTH,
	MAX_AUTOMATION_NAME_LENGTH,
	MAX_CRON_EXPRESSION_LENGTH,
	MAX_TIMEZONE_LENGTH,
	NAMED_TIME_ZONE,
	NonNegativeInt,
	PositiveInt,
	Timezone,
} from "@checkfu/sdk/Schemas"

export const MAX_PAUSE_REASON_LENGTH = 128

export const PAUSED_MANUALLY = "manual"
export const SCHEDULE_EXHAUSTED = "schedule_exhausted"

export const PauseReason = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(MAX_PAUSE_REASON_LENGTH),
)
