import { Chip } from "@checkfu/ui/chip"
import type { Tone } from "@checkfu/ui/chip"
import type * as React from "react"

const TONES = new Map<string, Tone>([
	["running", "green"],
	["active", "green"],
	["idle", "gray"],
	["paused", "yellow"],
	["terminated", "gray"],
	["archived", "gray"],
])

export function Status({ status }: { readonly status: string }): React.JSX.Element {
	return (
		<Chip tone={TONES.get(status) ?? "neutral"} live={status === "running"}>
			{status.charAt(0).toUpperCase() + status.slice(1)}
		</Chip>
	)
}

export const lifecycle = (resource: { readonly archived_at: string | null }): string =>
	resource.archived_at === null ? "active" : "archived"
