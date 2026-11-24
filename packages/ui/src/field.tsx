import * as React from "react"
import { cn } from "./cn.ts"

export function Field({
	label,
	description,
	error,
	className,
	children,
}: {
	readonly label: React.ReactNode
	readonly description?: React.ReactNode
	readonly error?: React.ReactNode
	readonly className?: string
	readonly children: React.ReactElement<{ id?: string; "aria-describedby"?: string }>
}): React.JSX.Element {
	const id = React.useId()
	const hintId = `${id}-hint`
	const hint = error ?? description
	return (
		<div className={cn("grid gap-1.5", className)}>
			<label htmlFor={id} className="text-sm font-medium">
				{label}
			</label>
			{React.cloneElement(children, {
				id,
				...(hint === undefined ? {} : { "aria-describedby": hintId }),
			})}
			{hint === undefined ? null : (
				<p
					id={hintId}
					className={cn(
						"text-control",
						error === undefined ? "text-muted-foreground" : "text-destructive",
					)}
				>
					{hint}
				</p>
			)}
		</div>
	)
}
