import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"
import { RouteError } from "../pages/layout.tsx"

export const Route = createRootRouteWithContext<{ readonly queryClient: QueryClient }>()({
	component: Outlet,
	errorComponent: (props) => (
		<main className="mx-auto max-w-xl p-8">
			<RouteError {...props} />
		</main>
	),
})
