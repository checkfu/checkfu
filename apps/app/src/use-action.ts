import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryKey } from "@tanstack/react-query"
import { useRef } from "react"
import { ApiError, errorMessage, isSignedOut, newIdempotencyKey } from "./api.ts"

export function useAction<Args extends ReadonlyArray<unknown>, Result = void>(
	action: (...args: Args) => Promise<Result>,
	{
		mutationKey,
		invalidates,
		refreshes,
		then,
	}: {
		readonly mutationKey?: QueryKey
		readonly invalidates?: ReadonlyArray<QueryKey>
		readonly refreshes?: ReadonlyArray<QueryKey>
		readonly then?: (result: Result, ...args: Args) => void
	} = {},
) {
	const queryClient = useQueryClient()
	const mutation = useMutation({
		...(mutationKey === undefined ? {} : { mutationKey }),
		mutationFn: (args: Args) => action(...args),
		onSettled: () =>
			Promise.all([
				...(invalidates ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
				...(refreshes ?? []).map((queryKey) =>
					queryClient.invalidateQueries({ queryKey, refetchType: "all" }),
				),
			]),
	})
	return {
		run: (...args: Args): void => {
			if (then === undefined) {
				mutation.mutate(args)
			} else {
				mutation.mutate(args, { onSuccess: (result) => then(result, ...args) })
			}
		},
		pending: mutation.isPending,
		errorCode: mutation.error instanceof ApiError ? mutation.error.code : undefined,
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
