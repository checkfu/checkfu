import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryKey } from "@tanstack/react-query"
import { useRef } from "react"
import { errorMessage, isSignedOut, newIdempotencyKey } from "./api.ts"

export function useAction<Args extends ReadonlyArray<unknown>>(
	action: (...args: Args) => Promise<void>,
	invalidates?: QueryKey,
) {
	const queryClient = useQueryClient()
	const mutation = useMutation({
		mutationFn: (args: Args) => action(...args),
		onSuccess: () =>
			invalidates === undefined
				? undefined
				: queryClient.invalidateQueries({ queryKey: invalidates }),
	})
	return {
		run: (...args: Args): void => mutation.mutate(args),
		pending: mutation.isPending,
		error:
			mutation.error === null || isSignedOut(mutation.error)
				? undefined
				: errorMessage(mutation.error),
	}
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
