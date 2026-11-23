import * as Domain from "@alchemy.run/domain"
import { SessionId } from "./Session.id.ts"
import { NonEmptyString } from "./SessionTypes.ts"

export class UnknownModelRequest extends Domain.Rejection(
	"UnknownModelRequest",
	{
		session_id: SessionId,
		model_request_start_id: NonEmptyString,
	},
	{ httpApiStatus: 409, description: "No open model request exists with this id." },
) {}
