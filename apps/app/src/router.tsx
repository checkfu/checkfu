import { createRouter } from "@tanstack/react-router"
import { RouteError } from "./pages/layout.tsx"
import { routeTree } from "./routeTree.gen.ts"

export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	defaultPreloadDelay: 50,
	defaultPreloadStaleTime: 0,
	defaultErrorComponent: RouteError,
	scrollRestoration: true,
})

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router
	}
}
