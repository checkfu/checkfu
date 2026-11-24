import { useRef, useState } from "react"
import { errorMessage, newIdempotencyKey } from "./api.ts"

export function useAction<Args extends ReadonlyArray<unknown>>(
	action: (...args: Args) => Promise<void>,
) {
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string>()
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

export function useSubmissionKey() {
	const last = useRef<{ readonly body: string; readonly key: string }>(undefined)
	return {
		keyFor: (body: unknown): string => {
			const json = JSON.stringify(body)
			if (last.current?.body !== json) {
				last.current = { body: json, key: newIdempotencyKey() }
			}
			return last.current.key
		},
		settle: (): void => {
			last.current = undefined
		},
	}
}
