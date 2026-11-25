import { Button } from "@checkfu/ui/button"
import { Field } from "@checkfu/ui/field"
import { Input } from "@checkfu/ui/input"
import { Logo } from "@checkfu/ui/logo"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useActionState } from "react"
import type * as React from "react"
import { signIn } from "../api.ts"

const MESSAGES = {
	rejected: "That key was not accepted.",
	failed: "Could not reach the API. Try again.",
} as const

export function SignInPage(): React.JSX.Element {
	const navigate = useNavigate()
	const { redirect } = useSearch({ from: "/sign-in" })
	const queryClient = useQueryClient()
	const [error, submit, pending] = useActionState(
		async (_previous: string | undefined, form: FormData): Promise<string | undefined> => {
			const key = form.get("key")
			const result =
				typeof key === "string" ? await signIn(key).catch(() => "failed" as const) : "rejected"
			if (result !== "ok") {
				return MESSAGES[result]
			}
			queryClient.clear()
			await (redirect === undefined ? navigate({ to: "/sessions" }) : navigate({ href: redirect }))
			return undefined
		},
		undefined,
	)
	return (
		<main className="flex min-h-svh items-center justify-center px-5">
			<form action={submit} className="w-full max-w-sm space-y-5">
				<Logo className="h-6 w-auto" />
				<Field
					label="API key"
					description="The CHECKFU_API_KEY of this deployment. It is kept in an HttpOnly cookie."
					error={error}
				>
					<Input
						type="password"
						autoComplete="current-password"
						name="key"
						required
						aria-invalid={error === undefined ? undefined : true}
					/>
				</Field>
				<Button type="submit" className="w-full" disabled={pending}>
					Sign in
				</Button>
			</form>
		</main>
	)
}
