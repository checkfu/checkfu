import type {
	ArtifactAccessLevel,
	ArtifactCapabilities,
	ArtifactDataGrant,
	ArtifactVisitorAccess,
} from "./Schemas.ts"

type CollectionAccess = typeof ArtifactVisitorAccess.Type

export const accessAt = (
	level: ArtifactAccessLevel,
	visitors: CollectionAccess,
): CollectionAccess => {
	if (level === "write") {
		return visitors
	}
	return level === "read" && (visitors === "read" || visitors === "write") ? "read" : "none"
}

export const declaredFor = (
	capabilities: ArtifactCapabilities,
	collection: string,
): CollectionAccess => {
	const collections = capabilities.database?.collections ?? {}
	return Object.hasOwn(collections, collection)
		? (collections[collection]?.visitors ?? "none")
		: "none"
}

export const grantAt = (
	level: ArtifactAccessLevel,
	capabilities: ArtifactCapabilities,
): ArtifactDataGrant =>
	Object.fromEntries(
		Object.keys(capabilities.database?.collections ?? {})
			.toSorted()
			.flatMap((collection) => {
				const access = accessAt(level, declaredFor(capabilities, collection))
				return access === "none" ? [] : [[collection, access]]
			}),
	)
