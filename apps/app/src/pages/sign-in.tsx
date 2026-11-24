import { Button } from "@checkfu/ui/button"
import { Field } from "@checkfu/ui/field"
import { Input } from "@checkfu/ui/input"
import { Logo } from "@checkfu/ui/logo"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type * as React from "react"
import { signIn } from "../api.ts"

const MESSAGES = {
	rejected: "That key was not accepted.",
	failed: "Could not reach the API. Try again.",
} as const

export function SignInPage(): React.JSX.Element {
	const navigate = useNavigate()
	const [key, setKey] = useState("")
	const queryClient = useQueryClient()
	const attempt = useMutation({
		mutationFn: (submitted: string) => signIn(submitted).catch(() => "failed" as const),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries()
			if (result === "ok") {
				void navigate({ to: "/sessions" })
			}
		},
	})
	const pending = attempt.isPending
	const error =
		attempt.data === undefined || attempt.data === "ok" ? undefined : MESSAGES[attempt.data]
	const submit = (event: React.FormEvent): void => {
		event.preventDefault()
		attempt.mutate(key)
	}
	return (
		<main className="flex min-h-svh items-center justify-center px-5">
			<form onSubmit={submit} className="w-full max-w-sm space-y-5">
				<Logo className="h-6 w-auto" />
				<Field
					label="API key"
					description="The CHECKFU_API_KEY of this deployment. It is kept in an HttpOnly cookie."
					error={error}
				>
					<Input
						type="password"
						autoComplete="current-password"
						required
						value={key}
						aria-invalid={error === undefined ? undefined : true}
						onChange={(event) => setKey(event.target.value)}
					/>
				</Field>
				<Button type="submit" className="w-full" disabled={pending || key.trim() === ""}>
					Sign in
				</Button>
			</form>
		</main>
	)
}
