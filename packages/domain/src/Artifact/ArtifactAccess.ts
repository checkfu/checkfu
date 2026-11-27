import { ArtifactDataGrant, MAX_ARTIFACT_GRANT_TEXT_LENGTH } from "@checkfu/sdk/Schemas"
import type { ArtifactVisitorAccess } from "@checkfu/sdk/Schemas"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export { accessAt, declaredFor, grantAt } from "@checkfu/sdk/ArtifactAccess"
export { ArtifactAccessLevel, ArtifactDataGrant } from "@checkfu/sdk/Schemas"

export type CollectionAccess = typeof ArtifactVisitorAccess.Type

export const DATA_OPERATIONS = ["list", "get", "add", "put", "delete"] as const
export type DataOperation = (typeof DATA_OPERATIONS)[number]

const ALLOWED: Readonly<Record<CollectionAccess, ReadonlyArray<DataOperation>>> = {
	none: [],
	read: ["list", "get"],
	add: ["add"],
	write: DATA_OPERATIONS,
}

export const permits = (access: CollectionAccess, operation: DataOperation): boolean =>
	ALLOWED[access].includes(operation)

export const both = (one: CollectionAccess, other: CollectionAccess): CollectionAccess => {
	if (one === other || other === "write") {
		return one
	}
	return one === "write" ? other : "none"
}

export const grantedFor = (grant: ArtifactDataGrant, collection: string): CollectionAccess =>
	Object.hasOwn(grant, collection) ? (grant[collection] ?? "none") : "none"

export const GrantText = Schema.String.check(Schema.isMaxLength(MAX_ARTIFACT_GRANT_TEXT_LENGTH))

const grantJson = Schema.fromJsonString(ArtifactDataGrant)
const encode = Schema.encodeUnknownOption(grantJson)
const read = Schema.decodeOption(grantJson)
const fits = Schema.is(GrantText)

export const encodeGrant = (grant: ArtifactDataGrant): string | undefined => {
	const names = Object.keys(grant).toSorted()
	return names.length === 0
		? ""
		: Option.getOrUndefined(
				Option.filter(encode(Object.fromEntries(names.map((name) => [name, grant[name]]))), fits),
			)
}

export const decodeGrant = (text: string): ArtifactDataGrant =>
	text === "" ? {} : Option.getOrElse(read(text), () => ({}))
