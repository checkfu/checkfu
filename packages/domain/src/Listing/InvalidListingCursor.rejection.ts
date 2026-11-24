import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"

export class InvalidListingCursor extends Domain.Rejection(
	"InvalidListingCursor",
	{ cursor: Schema.String },
	{ httpApiStatus: 400, description: "The cursor is not one a list page returned." },
) {}
