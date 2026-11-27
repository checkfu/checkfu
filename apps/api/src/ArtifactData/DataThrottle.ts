import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const DATA_CALLS_PER_MINUTE_PER_CALLER = 120
export const DATA_CALLS_PER_MINUTE_PER_ARTIFACT = 1200
export const DATA_THROTTLE_PERIOD_SECONDS = 60

export interface DataThrottleService {
	readonly admit: (artifactId: string, caller: string) => Effect.Effect<boolean>
}

export class DataThrottle extends Context.Service<DataThrottle, DataThrottleService>()(
	"@checkfu/api/DataThrottle",
) {}

export const makeDataThrottleMemory = () => {
	const counts = new Map<string, number>()
	const within = (key: string, limit: number) => {
		const used = (counts.get(key) ?? 0) + 1
		counts.set(key, used)
		return used <= limit
	}
	return {
		reset: () => {
			counts.clear()
		},
		layer: Layer.succeed(DataThrottle, {
			admit: (artifactId, caller) =>
				Effect.sync(
					() =>
						within(`${artifactId}:${caller}`, DATA_CALLS_PER_MINUTE_PER_CALLER) &&
						within(artifactId, DATA_CALLS_PER_MINUTE_PER_ARTIFACT),
				),
		}),
	}
}
