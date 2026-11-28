import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { Input } from "@checkfu/ui/input"
import { Link } from "@tanstack/react-router"
import type * as React from "react"
import type { Lookup } from "../queries.ts"
import { fileMountError } from "../session-resources.ts"
import type { ResourceDraft } from "../session-resources.ts"

type File = Extract<ResourceDraft, { type: "file" }>

export default function SavedFileFields({
	draft,
	check,
	onChange,
}: {
	readonly draft: File
	readonly check:
		| (Lookup<string> & { readonly retry: () => void; readonly signedOut?: boolean })
		| undefined
	readonly onChange: (draft: File) => void
}): React.JSX.Element {
	const error = fileMountError(draft)
	return (
		<>
			{check?.state === "active" ? (
				<p className="break-all text-sm">{check.found} · read-only</p>
			) : check?.state === "gone" ? (
				<Callout tone="error">This saved file is no longer available.</Callout>
			) : check?.state === "failed" ? (
				<Callout tone="error">
					{check.signedOut ? (
						<Link to="/sign-in" target="_blank" rel="noopener" className="underline">
							Sign in again
						</Link>
					) : (
						"Could not check this file."
					)}{" "}
					<button type="button" className="underline" onClick={check.retry}>
						Retry file check
					</button>
				</Callout>
			) : (
				<p className="text-sm text-muted-foreground" role="status">
					Checking saved file…
				</p>
			)}
			<Field label="File mount path" description="Relative to /mnt/session/uploads." error={error}>
				<Input
					aria-invalid={error !== undefined}
					placeholder={check?.state === "active" ? check.found : ""}
					value={draft.mountPath}
					onChange={(event) => onChange({ ...draft, mountPath: event.target.value })}
				/>
			</Field>
		</>
	)
}
