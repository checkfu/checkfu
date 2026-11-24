import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { errorMessage, isSignedOut, newIdempotencyKey } from "./api.ts"

export function useAction<Args extends ReadonlyArray<unknown>>(
	action: (...args: Args) => Promise<void>,
) {
	const navigate = useNavigate()
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string>()
	const run = (...args: Args): void => {
		setPending(true)
		setError(undefined)
		action(...args).then(
			() => setPending(false),
			(error_: unknown) => {
				setPending(false)
				if (isSignedOut(error_)) {
					void navigate({ to: "/sign-in", replace: true })
				} else {
					setError(errorMessage(error_))
				}
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
