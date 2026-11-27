import type { EnvironmentConfig } from "./Schemas.ts"

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
	type: "cloud",
	networking: { type: "unrestricted" },
}
