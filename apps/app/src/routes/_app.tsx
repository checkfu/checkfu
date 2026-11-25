import { createFileRoute, redirect } from "@tanstack/react-router"
import { signedIn } from "../api.ts"
import { Layout, RouteError } from "../pages/layout.tsx"

export const Route = createFileRoute("/_app")({
	beforeLoad: async () => {
		if (!(await signedIn())) {
			redirect({ to: "/sign-in", throw: true })
		}
	},
	component: Layout,
	errorComponent: RouteError,
})
