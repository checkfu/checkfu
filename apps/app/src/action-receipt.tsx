import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Link } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { isSignedOut } from "./api.ts"
import type { AcceptedReceipt } from "./api.ts"

export function ActionReceipt({
	receipt,
	href,
	onVisible,
}: {
	readonly receipt: AcceptedReceipt | undefined
	readonly href?: (id: string) => string
	readonly onVisible?: () => void | Promise<void>
}) {
	return receipt === undefined ? null : (
		<Receipt key={receipt.id} receipt={receipt} href={href} onVisible={onVisible} />
	)
}

function Receipt({
	receipt,
	href,
	onVisible,
}: {
	readonly receipt: AcceptedReceipt
	readonly href?: ((id: string) => string) | undefined
	readonly onVisible?: (() => void | Promise<void>) | undefined
}) {
	const status = useMutation({
		onSuccess: (outcome) => (outcome === "visible" ? onVisible?.() : undefined),
		mutationFn: () =>
			receipt.check().then(
				(visible) => (visible ? ("visible" as const) : ("pending" as const)),
				(error: unknown) => (isSignedOut(error) ? ("signed-out" as const) : ("pending" as const)),
			),
	})
	const ready = status.data === "visible"
	const detail = ready && href !== undefined ? href(receipt.id) : undefined
	const inform =
		status.data === "signed-out" || (status.data === undefined && isSignedOut(receipt.cause))
	return (
		<Callout tone="info" className="mb-4 max-w-2xl">
			<p role="status">
				Change accepted for <code className="break-all">{receipt.id}</code>.{" "}
				{ready
					? "The change is now visible."
					: inform
						? "Sign in again before checking this change."
						: "The change is not visible yet."}
			</p>
			<div className="mt-2 flex items-center gap-3">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={status.isPending}
					onClick={() => status.mutate()}
				>
					{status.isPending ? "Checking…" : "Check change"}
				</Button>
				{!ready && inform ? (
					<Link className="underline" to="/sign-in" target="_blank" rel="noopener noreferrer">
						Sign in (new tab)
					</Link>
				) : null}
				{detail === undefined ? null : (
					<a className="underline" href={detail}>
						Open resource
					</a>
				)}
			</div>
		</Callout>
	)
}
