import type * as React from "react"
import { CopyButton } from "./copy-button.tsx"
import { cn } from "./cn.ts"
import { shortId } from "./format.ts"

export function PageHeader({
	title,
	description,
	breadcrumb,
	id,
	accessory,
	actions,
	className,
}: {
	readonly title: React.ReactNode
	readonly description?: React.ReactNode
	readonly breadcrumb?: React.ReactNode
	readonly id?: string
	readonly accessory?: React.ReactNode
	readonly actions?: React.ReactNode
	readonly className?: string
}): React.JSX.Element {
	return (
		<header className={cn("space-y-2 pb-2", className)}>
			{breadcrumb === undefined ? null : (
				<nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
					{breadcrumb}
				</nav>
			)}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1 basis-80 space-y-1">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="min-w-0 truncate text-lg leading-6 font-medium">{title}</h1>
						{accessory}
					</div>
					{id === undefined ? null : (
						<p
							className="flex items-center gap-1 font-mono text-xs text-muted-foreground"
							title={id}
						>
							{shortId(id)}
							<CopyButton value={id} label="Copy ID" />
						</p>
					)}
					{description === undefined ? null : (
						<p className="text-sm text-muted-foreground">{description}</p>
					)}
				</div>
				{actions === undefined ? null : (
					<div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
				)}
			</div>
		</header>
	)
}

export function DescriptionList({
	children,
}: {
	readonly children: React.ReactNode
}): React.JSX.Element {
	return <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-2.5 text-sm">{children}</dl>
}

export function Description({
	label,
	children,
}: {
	readonly label: React.ReactNode
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</>
	)
}
