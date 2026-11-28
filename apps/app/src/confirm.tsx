import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { useMountEffect } from "@checkfu/ui/use-mount-effect"
import { useId, useRef } from "react"
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
	const description = useId()
	const cancel = useRef<HTMLButtonElement>(null)
	useMountEffect(() => {
		cancel.current?.focus()
	})

	return (
		<Callout className="max-w-2xl space-y-2" role="group" aria-labelledby={description}>
			<p id={description}>{children}</p>
			<div className="flex gap-2">
				<Button
					variant="destructive"
					size="sm"
					disabled={pending}
					aria-describedby={description}
					onClick={onConfirm}
				>
					{label}
				</Button>
				<Button
					ref={cancel}
					variant="ghost"
					size="sm"
					disabled={pending}
					aria-describedby={description}
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</Callout>
	)
}
