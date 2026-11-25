import type { CreateSessionBody } from "@checkfu/sdk/Api"
import type { JsonSession } from "@checkfu/sdk/client"

export type ResourceDraft =
	| {
			readonly type: "github_repository"
			readonly url: string
			readonly token: string
			readonly checkout: string
			readonly mountPath: string
	  }
	| {
			readonly type: "memory_store"
			readonly memoryStoreId: string
			readonly access: "read_write" | "read_only"
			readonly instructions: string
	  }
	| { readonly type: "artifact" | "skill"; readonly artifactId: string; readonly version: string }

export type ResourceType = ResourceDraft["type"]

export type CreateSessionRequest = CreateSessionBody

export type ResourceBody = NonNullable<CreateSessionRequest["resources"]>[number]

const checkoutOf = (
	text: string,
): Pick<Extract<ResourceBody, { type: "github_repository" }>, "checkout"> => {
	const trimmed = text.trim()
	return trimmed === ""
		? {}
		: /^[0-9a-f]{40}$/u.test(trimmed)
			? { checkout: { type: "commit", sha: trimmed } }
			: { checkout: { type: "branch", name: trimmed } }
}

export const RESOURCE_LABELS: Readonly<Record<ResourceType, string>> = {
	github_repository: "Repository",
	memory_store: "Memory store",
	artifact: "Artifact files",
	skill: "Skill",
}

export const emptyDraft = (type: ResourceType): ResourceDraft =>
	type === "github_repository"
		? { type, url: "", token: "", checkout: "", mountPath: "" }
		: type === "memory_store"
			? { type, memoryStoreId: "", access: "read_write", instructions: "" }
			: { type, artifactId: "", version: "" }

export const namesResource = (draft: ResourceDraft): boolean =>
	(draft.type === "github_repository"
		? draft.url
		: draft.type === "memory_store"
			? draft.memoryStoreId
			: draft.artifactId
	).trim() !== ""

const filled = (value: string): string | undefined => {
	const trimmed = value.trim()
	return trimmed === "" ? undefined : trimmed
}

const versionOf = (version: string): { readonly version?: number } => {
	const trimmed = version.trim()
	return trimmed === "" ? {} : { version: Number(trimmed) }
}

export const resourceBody = (draft: ResourceDraft): ResourceBody => {
	switch (draft.type) {
		case "github_repository":
			return {
				type: draft.type,
				url: draft.url.trim(),
				...(draft.token === "" ? {} : { authorization_token: draft.token }),
				...checkoutOf(draft.checkout),
				...(filled(draft.mountPath) === undefined ? {} : { mount_path: draft.mountPath.trim() }),
			}
		case "memory_store":
			return {
				type: draft.type,
				memory_store_id: draft.memoryStoreId,
				access: draft.access,
				...(filled(draft.instructions) === undefined
					? {}
					: { instructions: draft.instructions.trim() }),
			}
		case "artifact":
		case "skill":
			return { type: draft.type, artifact_id: draft.artifactId.trim(), ...versionOf(draft.version) }
	}
}

export type SessionResourceItem = JsonSession["resources"][number]

export interface ResourceSummary {
	readonly label: string
	readonly name: string
	readonly detail: string
}

export const describeResource = (resource: SessionResourceItem): ResourceSummary => {
	switch (resource.type) {
		case "github_repository":
			return {
				label: RESOURCE_LABELS.github_repository,
				name: resource.url,
				detail:
					resource.checkout === null
						? "default branch"
						: resource.checkout.type === "branch"
							? resource.checkout.name
							: resource.checkout.sha.slice(0, 12),
			}
		case "memory_store":
			return {
				label: RESOURCE_LABELS.memory_store,
				name: resource.name,
				detail: resource.access === "read_only" ? "read-only" : "read-write",
			}
		case "artifact":
		case "skill":
			return {
				label: RESOURCE_LABELS[resource.type],
				name: resource.name,
				detail: `v${resource.version}`,
			}
	}
}
