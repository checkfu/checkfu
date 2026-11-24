import { Button } from "@checkfu/ui/button"
import { Link } from "@tanstack/react-router"
import type * as React from "react"

export function Pager({
	next,
	paged,
}: {
	readonly next: string | null
	readonly paged: boolean
}): React.JSX.Element | null {
	if (next === null && !paged) {
		return null
	}
	return (
		<nav aria-label="Pages" className="flex gap-2">
			{paged ? (
				<Button variant="outline" size="sm" asChild>
					<Link to="." search={{}}>
						Newest
					</Link>
				</Button>
			) : null}
			{next === null ? null : (
				<Button variant="outline" size="sm" asChild>
					<Link to="." search={{ after: next }}>
						Older
					</Link>
				</Button>
			)}
		</nav>
	)
}
