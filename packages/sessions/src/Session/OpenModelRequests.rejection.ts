import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { SessionId } from "./Session.id.ts"
import { NonEmptyString } from "./SessionTypes.ts"

export class OpenModelRequests extends Domain.Rejection(
	"OpenModelRequests",
	{
		session_id: SessionId,
		open_model_request_ids: Schema.Array(NonEmptyString),
	},
	{
		httpApiStatus: 409,
		description: "Cannot transition to idle while model requests are still open.",
	},
) {}
