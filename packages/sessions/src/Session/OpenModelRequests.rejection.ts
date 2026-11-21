import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { NonEmptyString } from "./SessionTypes.ts"

export class OpenModelRequests extends Domain.Rejection(
	"OpenModelRequests",
	{
		session_id: SessionId,
		open_model_request_id: NonEmptyString,
	},
	{
		httpApiStatus: 409,
		description: "Cannot complete turn while a model request is still open.",
	},
) {}
