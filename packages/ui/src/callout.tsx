import type * as React from "react"
import { cn } from "./cn.ts"

const TONES = {
	info: "border-border bg-muted/50 text-muted-foreground",
	error: "border-destructive/30 bg-destructive/10 text-destructive",
} as const

export function Callout({
	tone = "info",
	className,
	...props
}: React.ComponentProps<"div"> & { readonly tone?: keyof typeof TONES }): React.JSX.Element {
	return (
		<div
			role={tone === "error" ? "alert" : "note"}
			className={cn("rounded-md border px-3 py-2.5 text-control", TONES[tone], className)}
			{...props}
		/>
	)
}
