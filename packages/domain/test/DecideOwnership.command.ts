import * as Domain from "@alchemy.run/domain"
import * as Schema from "effect/Schema"
import { OwnerAction, OwnerMarkFields, OwnerOperation } from "../src/Bytes/ByteOwnership.ts"
export const ownerStateFields = { ...OwnerMarkFields, action: OwnerAction }
export class OwnerDecided extends Domain.Event("owner.decided", ownerStateFields) {}
export class DecideOwnership extends Domain.Command("DecideOwnership", {
	input: { id: Schema.String, operation: OwnerOperation, reservation: Schema.Int },
	events: [OwnerDecided],
}) {}
