import type { JsonSessionEvent } from "@checkfu/sdk/client"

export const parseApiJson = <T>(text: string): T =>
	(text === "" ? undefined : JSON.parse(text)) as T

export const parseEventJson = (data: string): JsonSessionEvent =>
	JSON.parse(data) as JsonSessionEvent

export const parseJsonObject = <T extends object>(text: string): T | undefined => {
	try {
		const parsed: unknown = JSON.parse(text)
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as T)
			: undefined
	} catch {
		return undefined
	}
}
