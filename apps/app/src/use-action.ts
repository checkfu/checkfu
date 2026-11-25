import * as React from "react"
import { errorMessage } from "./api.ts"

export function useAction<Args extends ReadonlyArray<unknown>>(
	action: (...args: Args) => Promise<void>,
) {
	const [pending, setPending] = React.useState(false)
	const [error, setError] = React.useState<string>()
	const run = (...args: Args): void => {
		setPending(true)
		setError(undefined)
		action(...args).then(
			() => setPending(false),
			(error_: unknown) => {
				setPending(false)
				setError(errorMessage(error_))
			},
		)
	}
	return { run, pending, error }
}
