import * as Domain from "@alchemy.run/domain"
import { Session } from "./Session/Session.aggregate.ts"

export class Sessions extends Domain.Model("Sessions", {
	aggregates: [Session],
}) {}
