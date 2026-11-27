import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import type * as React from "react"

export function Confirm({
	label,
	pending,
	onConfirm,
	onCancel,
	children,
}: {
	readonly label: string
	readonly pending: boolean
	readonly onConfirm: () => void
	readonly onCancel: () => void
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<Callout className="max-w-2xl space-y-2">
			<p>{children}</p>
			<div className="flex gap-2">
				<Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
					{label}
				</Button>
				<Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</Callout>
	)
}
