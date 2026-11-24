import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	redirect,
} from "@tanstack/react-router"
import { checkfu, signedIn } from "./api.ts"
import { AgentPage, AgentsPage, NewAgentPage } from "./pages/agents.tsx"
import { EnvironmentPage, EnvironmentsPage, NewEnvironmentPage } from "./pages/environments.tsx"
import { Layout, RouteError } from "./pages/layout.tsx"
import { NewSessionPage, SessionPage, SessionsPage } from "./pages/sessions.tsx"
import { SignInPage } from "./pages/sign-in.tsx"

const PAGE = { limit: 100, order: "desc" } as const

const root = createRootRoute({
	component: Outlet,
	errorComponent: (props) => (
		<main className="mx-auto max-w-xl p-8">
			<RouteError {...props} />
		</main>
	),
})

const signIn = createRoute({ getParentRoute: () => root, path: "/sign-in", component: SignInPage })

const app = createRoute({
	getParentRoute: () => root,
	id: "app",
	beforeLoad: async () => {
		if (!(await signedIn())) {
			redirect({ to: "/sign-in", throw: true })
		}
	},
	component: Layout,
	errorComponent: RouteError,
})

const home = createRoute({
	getParentRoute: () => app,
	path: "/",
	beforeLoad: () => {
		redirect({ to: "/sessions", throw: true })
	},
})

const sessions = createRoute({
	getParentRoute: () => app,
	path: "/sessions",
	loader: () => checkfu.sessions.list(PAGE),
	component: SessionsPage,
})

const newSession = createRoute({
	getParentRoute: () => app,
	path: "/sessions/new",
	loader: async () => {
		const [agents, environments] = await Promise.all([
			checkfu.agents.list(PAGE),
			checkfu.environments.list(PAGE),
		])
		return { agents: agents.data, environments: environments.data }
	},
	component: NewSessionPage,
})

const session = createRoute({
	getParentRoute: () => app,
	path: "/sessions/$sessionId",
	loader: ({ params }) => checkfu.sessions.retrieve(params.sessionId),
	component: SessionPage,
})

const agents = createRoute({
	getParentRoute: () => app,
	path: "/agents",
	loader: () => checkfu.agents.list(PAGE),
	component: AgentsPage,
})

const newAgent = createRoute({
	getParentRoute: () => app,
	path: "/agents/new",
	component: NewAgentPage,
})

const agent = createRoute({
	getParentRoute: () => app,
	path: "/agents/$agentId",
	loader: ({ params }) => checkfu.agents.retrieve(params.agentId),
	component: AgentPage,
})

const environments = createRoute({
	getParentRoute: () => app,
	path: "/environments",
	loader: () => checkfu.environments.list(PAGE),
	component: EnvironmentsPage,
})

const newEnvironment = createRoute({
	getParentRoute: () => app,
	path: "/environments/new",
	component: NewEnvironmentPage,
})

const environment = createRoute({
	getParentRoute: () => app,
	path: "/environments/$environmentId",
	loader: ({ params }) => checkfu.environments.retrieve(params.environmentId),
	component: EnvironmentPage,
})

export const router = createRouter({
	routeTree: root.addChildren([
		signIn,
		app.addChildren([
			home,
			sessions,
			newSession,
			session,
			agents,
			newAgent,
			agent,
			environments,
			newEnvironment,
			environment,
		]),
	]),
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
	scrollRestoration: true,
})

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router
	}
}
