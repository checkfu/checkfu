import type { CreateSessionBody } from "@checkfu/sdk/Api"
import type { JsonSession } from "@checkfu/sdk/client"

type CheckoutKind = "default" | "branch" | "commit"

export type ResourceDraft =
	| {
			readonly type: "github_repository"
			readonly url: string
			readonly token: string
			readonly checkout: string
			readonly checkoutKind: CheckoutKind
			readonly access: "read_write" | "read_only"
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

type CheckoutDraft =
	| Pick<Extract<ResourceBody, { type: "github_repository" }>, "checkout">
	| { readonly error: string }

export const checkoutOf = (kind: CheckoutKind, text: string): CheckoutDraft => {
	const trimmed = text.trim()
	switch (kind) {
		case "default":
			return {}
		case "branch":
			return trimmed === ""
				? { error: "Enter a branch name." }
				: { checkout: { type: "branch", name: trimmed } }
		case "commit": {
			const sha = trimmed.toLowerCase()
			const full =
				sha.length === 40 &&
				Array.from(sha).every(
					(char) => (char >= "0" && char <= "9") || (char >= "a" && char <= "f"),
				)
			return full
				? { checkout: { type: "commit", sha } }
				: { error: "Enter the full 40-character commit ID." }
		}
	}
}

export const checkoutError = (draft: ResourceDraft): string | undefined => {
	if (draft.type !== "github_repository") {
		return undefined
	}
	const parsed = checkoutOf(draft.checkoutKind, draft.checkout)
	return "error" in parsed ? parsed.error : undefined
}

export const RESOURCE_LABELS: Readonly<Record<ResourceType, string>> = {
	github_repository: "Repository",
	memory_store: "Memory store",
	artifact: "Artifact files",
	skill: "Skill",
}

export const emptyDraft = (type: ResourceType): ResourceDraft =>
	type === "github_repository"
		? {
				type,
				url: "",
				token: "",
				checkout: "",
				checkoutKind: "default",
				mountPath: "",
				access: "read_write",
			}
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
		case "github_repository": {
			const checkout = checkoutOf(draft.checkoutKind, draft.checkout)
			if ("error" in checkout) {
				throw new Error(checkout.error)
			}
			return {
				type: draft.type,
				url: draft.url.trim(),
				...(draft.token === "" ? {} : { authorization_token: draft.token }),
				...checkout,
				...(draft.access === "read_only" ? { access: draft.access } : {}),
				...(filled(draft.mountPath) === undefined ? {} : { mount_path: draft.mountPath.trim() }),
			}
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

export const resourceIdentity = (draft: ResourceDraft): ResourceBody =>
	resourceBody(draft.type === "github_repository" ? { ...draft, token: "" } : draft)

export type SessionResourceItem = JsonSession["resources"][number]

export interface ResourceSummary {
	readonly label: string
	readonly name: string
	readonly detail: string
}

export const describeResource = (resource: SessionResourceItem): ResourceSummary => {
	switch (resource.type) {
		case "github_repository": {
			const checkout = resource.checkout
			const ref =
				checkout === null
					? "default branch"
					: checkout.type === "branch"
						? checkout.name
						: checkout.sha.slice(0, 12)
			const access = resource.access === "read_only" ? "read-only" : "read-write"
			return {
				label: RESOURCE_LABELS.github_repository,
				name: resource.url,
				detail: `${ref} · ${access}`,
			}
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
