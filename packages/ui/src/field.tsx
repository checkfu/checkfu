import { cloneElement, useId } from "react"
import type * as React from "react"
import { cn } from "./cn.ts"

type Control = React.ReactElement<{ id?: string; "aria-describedby"?: string }>

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
	readonly children: Control
}): React.JSX.Element {
	const generated = useId()
	const id = children.props.id ?? generated
	const descriptionId = `${id}-description`
	const errorId = `${id}-error`
	const describedBy = [
		children.props["aria-describedby"],
		description === undefined ? undefined : descriptionId,
		error === undefined ? undefined : errorId,
	]
		.filter((part) => part !== undefined)
		.join(" ")
	return (
		<div className={cn("grid gap-1.5", className)}>
			<label htmlFor={id} className="text-sm font-medium">
				{label}
			</label>
			{cloneElement(children, {
				id,
				...(describedBy === "" ? {} : { "aria-describedby": describedBy }),
			})}
			{description === undefined ? null : (
				<p id={descriptionId} className="text-control text-muted-foreground">
					{description}
				</p>
			)}
			{error === undefined ? null : (
				<p id={errorId} role="alert" className="text-control text-destructive">
					{error}
				</p>
			)}
		</div>
	)
}
