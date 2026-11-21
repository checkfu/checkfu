import * as Domain from "@alchemy.run/domain"
import { EnvironmentId } from "./Environment.id.ts"

export class EnvironmentNotFound extends Domain.Rejection(
	"EnvironmentNotFound",
	{ environment_id: EnvironmentId },
	{ httpApiStatus: 404, description: "Environment does not exist." },
) {}
