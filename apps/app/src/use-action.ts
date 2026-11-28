import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryKey } from "@tanstack/react-query"
import { useRef } from "react"
import { isAcceptedReceipt, ApiError, errorMessage, isSignedOut, newIdempotencyKey } from "./api.ts"

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
	const invalidate = () =>
		Promise.all([
			...(invalidates ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			...(refreshes ?? []).map((queryKey) =>
				queryClient.invalidateQueries({ queryKey, refetchType: "all" }),
			),
		])
	const mutation = useMutation({
		...(mutationKey === undefined ? {} : { mutationKey }),
		mutationFn: (args: Args) => action(...args),
		onSettled: (_data, error) => (isAcceptedReceipt(error) ? undefined : invalidate()),
	})
	const receipt = isAcceptedReceipt(mutation.error) ? mutation.error : undefined
	return {
		run: (...args: Args): void => {
			if (mutation.isPending || receipt !== undefined) {
				return
			}
			if (then === undefined) {
				mutation.mutate(args)
			} else {
				mutation.mutate(args, { onSuccess: (result) => then(result, ...args) })
			}
		},
		pending: mutation.isPending,
		receipt,
		blocked: mutation.isPending || receipt !== undefined,
		confirmReceipt: async () => {
			await invalidate()
			mutation.reset()
		},
		errorCode: mutation.error instanceof ApiError ? mutation.error.code : undefined,
		error:
			mutation.error === null || receipt !== undefined || isSignedOut(mutation.error)
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
