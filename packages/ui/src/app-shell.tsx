import { Slot } from "radix-ui"
import type * as React from "react"
import { cn } from "./cn.ts"

export function AppShell({
	brand,
	nav,
	footer,
	children,
}: {
	readonly brand: React.ReactNode
	readonly nav: React.ReactNode
	readonly footer?: React.ReactNode
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<div className="min-h-svh md:grid md:grid-cols-[14rem_1fr]">
			<aside className="flex items-center gap-4 border-b px-3 py-2 md:sticky md:top-0 md:h-svh md:flex-col md:items-stretch md:border-r md:border-b-0 md:py-3">
				<div className="flex h-9 items-center px-2">{brand}</div>
				<nav
					aria-label="Main"
					className="flex flex-1 gap-0.5 overflow-x-auto md:flex-col md:overflow-visible"
				>
					{nav}
				</nav>
				{footer === undefined ? null : (
					<div className="flex items-center gap-1 md:border-t md:pt-2">{footer}</div>
				)}
			</aside>
			<main className="mx-auto w-full max-w-6xl min-w-0 space-y-6 px-5 py-6 md:px-8">
				{children}
			</main>
		</div>
	)
}

export function NavItem({
	className,
	...props
}: React.ComponentProps<typeof Slot.Root>): React.JSX.Element {
	return (
		<Slot.Root
			className={cn(
				"flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
				className,
			)}
			{...props}
		/>
	)
}
