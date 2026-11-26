import { Chip } from "@checkfu/ui/chip"
import type { Tone } from "@checkfu/ui/chip"
import type * as React from "react"

const TONES = new Map<string, Tone>([
	["running", "green"],
	["active", "green"],
	["idle", "gray"],
	["paused", "yellow"],
	["waiting", "yellow"],
	["terminated", "gray"],
	["archived", "gray"],
	["started", "green"],
	["failed", "red"],
	["storing", "yellow"],
	["held", "green"],
	["erasing", "yellow"],
	["erased", "gray"],
])

const LABELS = new Map<string, string>([["waiting", "Waiting on you"]])

export function Status({ status }: { readonly status: string }): React.JSX.Element {
	return (
		<Chip tone={TONES.get(status) ?? "neutral"} live={status === "running"}>
			{LABELS.get(status) ?? status.charAt(0).toUpperCase() + status.slice(1)}
		</Chip>
	)
}

export function LifecycleStatus({
	resource,
}: {
	readonly resource: { readonly archived_at: string | null }
}): React.JSX.Element {
	return <Status status={resource.archived_at === null ? "active" : "archived"} />
}
