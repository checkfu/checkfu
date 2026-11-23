import * as Schema from "effect/Schema"

export const MAX_ENVIRONMENT_NAME_LENGTH = 256
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 1024

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const EnvironmentName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_NAME_LENGTH),
)
export const EnvironmentDescription = Schema.String.check(
	Schema.isMaxCodePoints(MAX_ENVIRONMENT_DESCRIPTION_LENGTH),
)
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const EnvironmentNetworking = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("unrestricted"),
	}),
	Schema.Struct({
		type: Schema.Literal("limited"),
		allow_mcp_servers: Schema.Boolean,
		allow_package_managers: Schema.Boolean,
		allowed_hosts: Schema.Array(NonEmptyString),
	}),
])
export type EnvironmentNetworking = typeof EnvironmentNetworking.Type

export const sameNetworkingFlags = (a: EnvironmentNetworking, b: EnvironmentNetworking): boolean =>
	a.type === "limited"
		? b.type === "limited" &&
			a.allow_mcp_servers === b.allow_mcp_servers &&
			a.allow_package_managers === b.allow_package_managers
		: b.type === "unrestricted"

export const sameNetworking = (a: EnvironmentNetworking, b: EnvironmentNetworking): boolean =>
	sameNetworkingFlags(a, b) &&
	(a.type !== "limited" ||
		b.type !== "limited" ||
		(a.allowed_hosts.length === b.allowed_hosts.length &&
			a.allowed_hosts.every((host, index) => host === b.allowed_hosts[index])))

export const EnvironmentConfig = Schema.Struct({
	type: Schema.Literal("cloud"),
	networking: EnvironmentNetworking,
})
export type EnvironmentConfig = typeof EnvironmentConfig.Type
