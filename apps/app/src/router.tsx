import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query"
import { createRouter } from "@tanstack/react-router"
import { ApiError, isSignedOut } from "./api.ts"
import { RouteError } from "./pages/layout.tsx"
import { signInSearch } from "./return-to.ts"
import { routeTree } from "./routeTree.gen.ts"

const toSignIn = (error: unknown) => {
	if (isSignedOut(error) && !router.state.location.pathname.startsWith("/sign-in")) {
		void router.navigate({
			to: "/sign-in",
			search: signInSearch(router.state.location.href),
			replace: true,
		})
	}
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({ onError: toSignIn }),
	mutationCache: new MutationCache({ onError: toSignIn }),
	defaultOptions: {
		queries: {
			retry: (failures, error) =>
				failures < 2 && !(error instanceof ApiError && error.status < 500),
		},
	},
})

export const router = createRouter({
	routeTree,
	context: { queryClient },
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
