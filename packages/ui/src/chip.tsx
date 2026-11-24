import type * as React from "react"
import { cn } from "./cn.ts"

export type Tone = "green" | "yellow" | "blue" | "red" | "gray" | "neutral"

const TONES: Record<Tone, string> = {
	green: "bg-(--tone-green-bg) text-(--tone-green-ink)",
	yellow: "bg-(--tone-yellow-bg) text-(--tone-yellow-ink)",
	blue: "bg-(--tone-blue-bg) text-(--tone-blue-ink)",
	red: "bg-(--tone-red-bg) text-(--tone-red-ink)",
	gray: "bg-(--tone-gray-bg) text-(--tone-gray-ink)",
	neutral: "bg-muted text-muted-foreground",
}

export function Chip({
	tone = "neutral",
	live = false,
	className,
	children,
}: {
	readonly tone?: Tone
	readonly live?: boolean
	readonly className?: string
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs leading-snug font-medium whitespace-nowrap",
				TONES[tone],
				className,
			)}
		>
			{live ? <span className="live-dot size-1.5 rounded-full bg-current opacity-70" /> : null}
			{children}
		</span>
	)
}
