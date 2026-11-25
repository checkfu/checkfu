import { createFileRoute } from "@tanstack/react-router"
import { SignInPage } from "../pages/sign-in.tsx"
import { returnTo } from "../return-to.ts"

export const Route = createFileRoute("/sign-in")({
	validateSearch: (search: { readonly redirect?: unknown }): { readonly redirect?: string } => {
		const target = returnTo(search.redirect)
		return target === undefined ? {} : { redirect: target }
	},
	component: SignInPage,
})
