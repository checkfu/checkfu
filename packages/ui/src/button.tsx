import { cva } from "class-variance-authority"
import type { VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import type * as React from "react"
import { cn } from "./cn.ts"

export const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary/80",
				outline: "border-border bg-background hover:bg-muted dark:border-input dark:bg-input/30",
				ghost: "hover:bg-muted hover:text-foreground",
				destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
			},
			size: {
				default: "h-8 px-2.5",
				sm: "h-7 px-2.5 text-control [&_svg:not([class*='size-'])]:size-3.5",
				icon: "size-8",
				"icon-sm": "size-7",
				"icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
)

export function Button({
	className,
	variant,
	size,
	asChild = false,
	type,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & { readonly asChild?: boolean }): React.JSX.Element {
	const Comp = asChild ? Slot.Root : "button"
	return (
		<Comp
			type={asChild ? undefined : (type ?? "button")}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	)
}
