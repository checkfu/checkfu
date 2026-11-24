import { CheckIcon, CopyIcon } from "lucide-react"
import { useRef, useState } from "react"
import type * as React from "react"
import { Button } from "./button.tsx"
import { useMountEffect } from "./use-mount-effect.ts"

export function CopyButton({
	value,
	label = "Copy",
}: {
	readonly value: string
	readonly label?: string
}): React.JSX.Element {
	const [copied, setCopied] = useState(false)
	const reset = useRef<ReturnType<typeof setTimeout>>(undefined)
	useMountEffect(() => () => clearTimeout(reset.current))
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			className="text-muted-foreground"
			aria-label={copied ? "Copied" : label}
			onClick={() => {
				void navigator.clipboard.writeText(value).then(
					() => {
						clearTimeout(reset.current)
						setCopied(true)
						reset.current = setTimeout(() => setCopied(false), 1500)
					},
					() => setCopied(false),
				)
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	)
}
