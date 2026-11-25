import type { JsonSessionEvent } from "@checkfu/sdk/client"

export const parseApiJson = <T>(text: string): T =>
	(text === "" ? undefined : JSON.parse(text)) as T

export const parseEventJson = (data: string): JsonSessionEvent =>
	JSON.parse(data) as JsonSessionEvent
