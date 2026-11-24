import type * as React from "react"
import { cn } from "./cn.ts"

export const controlClassName =
	"w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"

export function Input({ className, ...props }: React.ComponentProps<"input">): React.JSX.Element {
	return <input className={cn(controlClassName, "h-8 py-1", className)} {...props} />
}

export function Textarea({
	className,
	...props
}: React.ComponentProps<"textarea">): React.JSX.Element {
	return (
		<textarea
			className={cn(controlClassName, "field-sizing-content min-h-16 py-2", className)}
			{...props}
		/>
	)
}

export function Select({ className, ...props }: React.ComponentProps<"select">): React.JSX.Element {
	return <select className={cn(controlClassName, "h-8 py-1", className)} {...props} />
}
