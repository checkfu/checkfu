import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as NetAddress from "effect/net/NetAddress"
import * as Option from "effect/Option"
import * as Result from "effect/Result"

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

export const callerNetwork = (caller: string): string => {
	const parsed = NetAddress.ipFromString(caller)
	if (Result.isFailure(parsed)) {
		return caller
	}
	const address = parsed.success
	if (NetAddress.isIpv4Address(address)) {
		return NetAddress.formatIp(address)
	}
	const mapped = NetAddress.fromIpv4Mapped(address)
	if (Option.isSome(mapped)) {
		return NetAddress.formatIp(mapped.value)
	}
	return NetAddress.ipv6ToSegments(address)
		.slice(0, 4)
		.map((segment) => segment.toString(16))
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
