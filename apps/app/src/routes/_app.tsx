import { createFileRoute, redirect } from "@tanstack/react-router"
import { signedIn } from "../api.ts"
import { signInSearch } from "../return-to.ts"
import { Layout, RouteError } from "../pages/layout.tsx"

export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ location }) => {
		if (!(await signedIn())) {
			redirect({ to: "/sign-in", search: signInSearch(location.href), throw: true })
		}
	},
	component: Layout,
	errorComponent: RouteError,
})
