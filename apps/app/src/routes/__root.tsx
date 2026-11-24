import { createRootRoute, Outlet } from "@tanstack/react-router"
import { RouteError } from "../pages/layout.tsx"

export const Route = createRootRoute({
	component: Outlet,
	errorComponent: (props) => (
		<main className="mx-auto max-w-xl p-8">
			<RouteError {...props} />
		</main>
	),
})
