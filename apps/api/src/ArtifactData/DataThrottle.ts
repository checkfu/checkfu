import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const DATA_CALLS_PER_MINUTE_PER_CALLER = 120
export const DATA_CALLS_PER_MINUTE_PER_ARTIFACT = 1200
export const DATA_THROTTLE_PERIOD_SECONDS = 60

export type DataCallKind = "read" | "write"

export interface DataThrottleService {
	readonly admit: (artifactId: string, caller: string, kind: DataCallKind) => Effect.Effect<boolean>
}

export class DataThrottle extends Context.Service<DataThrottle, DataThrottleService>()(
	"@checkfu/api/DataThrottle",
) {}

const NETWORK_GROUPS = 4
const ADDRESS_GROUPS = 8

export const callerNetwork = (caller: string): string => {
	if (!caller.includes(":")) {
		return caller
	}
	const [head = "", tail] = caller.toLowerCase().split("::")
	const leading = head === "" ? [] : head.split(":")
	const trailing = tail === undefined || tail === "" ? [] : tail.split(":")
	const missing =
		tail === undefined ? 0 : Math.max(0, ADDRESS_GROUPS - leading.length - trailing.length)
	return [...leading, ...Array.from({ length: missing }, () => "0"), ...trailing]
		.slice(0, NETWORK_GROUPS)
		.map((group) => {
			const value = Number.parseInt(group, 16)
			return Number.isNaN(value) ? group : value.toString(16)
		})
		.join(":")
}

export const callerKey = (artifactId: string, caller: string) =>
	`${artifactId}:${callerNetwork(caller)}`

export const artifactKey = (artifactId: string, kind: DataCallKind) => `${artifactId}:${kind}`

const counter = (limit: number) => {
	const counts = new Map<string, number>()
	return (key: string) => {
		const used = (counts.get(key) ?? 0) + 1
		counts.set(key, used)
		return used <= limit
	}
}

export const makeDataThrottleMemory = () => {
	const withinCaller = counter(DATA_CALLS_PER_MINUTE_PER_CALLER)
	const withinArtifact = counter(DATA_CALLS_PER_MINUTE_PER_ARTIFACT)
	return {
		layer: Layer.succeed(DataThrottle, {
			admit: (artifactId, caller, kind) =>
				Effect.sync(
					() =>
						withinCaller(callerKey(artifactId, caller)) &&
						withinArtifact(artifactKey(artifactId, kind)),
				),
		}),
	}
}
