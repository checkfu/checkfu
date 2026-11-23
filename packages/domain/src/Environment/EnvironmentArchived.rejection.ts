import * as Domain from "@alchemy.run/domain"
import { EnvironmentId } from "./Environment.id.ts"

export class EnvironmentArchivedError extends Domain.Rejection(
	"EnvironmentArchivedError",
	{ environment_id: EnvironmentId },
	{ httpApiStatus: 409, description: "Environment is archived and cannot be modified." },
) {}
