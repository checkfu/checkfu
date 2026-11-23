import * as Domain from "@alchemy.run/domain"
import { AgentVersionId } from "./AgentVersion.id.ts"

export class AgentVersionAlreadyExists extends Domain.Rejection(
	"AgentVersionAlreadyExists",
	{ version_id: AgentVersionId },
	{ httpApiStatus: 409, description: "An agent version with this id already exists." },
) {}
