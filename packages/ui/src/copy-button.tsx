import { CheckIcon, CopyIcon } from "lucide-react"
import * as React from "react"
import { Button } from "./button.tsx"

export function CopyButton({
	value,
	label = "Copy",
}: {
	readonly value: string
	readonly label?: string
}): React.JSX.Element {
	const [copied, setCopied] = React.useState(false)
	React.useEffect(() => {
		if (!copied) {
			return
		}
		const timer = setTimeout(() => setCopied(false), 1500)
		return () => clearTimeout(timer)
	}, [copied])
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			className="text-muted-foreground"
			aria-label={copied ? "Copied" : label}
			onClick={() => {
				void navigator.clipboard.writeText(value).then(
					() => setCopied(true),
					() => setCopied(false),
				)
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	)
}
