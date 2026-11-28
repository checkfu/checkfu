import { AppShell, NavItem } from "@checkfu/ui/app-shell"
import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Logo } from "@checkfu/ui/logo"
import { ThemeToggle } from "@checkfu/ui/theme"
import { useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, Outlet, useNavigate, useRouter } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import {
	BotIcon,
	BoxIcon,
	CalendarClockIcon,
	DatabaseIcon,
	FileStackIcon,
	KeyRoundIcon,
	LogOutIcon,
	MessagesSquareIcon,
	WebhookIcon,
} from "lucide-react"
import type * as React from "react"
import { errorMessage, isSignedOut, signOut } from "../api.ts"
import { signInSearch } from "../return-to.ts"
import { useAction } from "../use-action.ts"

export function Layout(): React.JSX.Element {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const signOutAction = useAction(
		async () => {
			await signOut()
			queryClient.clear()
		},
		{ then: () => void navigate({ to: "/sign-in" }) },
	)
	return (
		<AppShell
			brand={
				<Link to="/sessions" aria-label="Checkfu home">
					<Logo className="h-5 w-auto" />
				</Link>
			}
			nav={
				<>
					<NavItem>
						<Link to="/sessions">
							<MessagesSquareIcon /> Sessions
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/agents">
							<BotIcon /> Agents
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/environments">
							<BoxIcon /> Environments
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/automations">
							<CalendarClockIcon /> Automations
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/artifacts">
							<FileStackIcon /> Artifacts
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/memory-stores">
							<DatabaseIcon /> Memory
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/vaults">
							<KeyRoundIcon /> Vaults
						</Link>
					</NavItem>
					<NavItem>
						<Link to="/webhooks">
							<WebhookIcon /> Webhooks
						</Link>
					</NavItem>
				</>
			}
			footer={
				<>
					<ThemeToggle />
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Sign out"
						disabled={signOutAction.pending}
						onClick={() => signOutAction.run()}
					>
						<LogOutIcon />
					</Button>
				</>
			}
		>
			{signOutAction.error === undefined ? null : (
				<Callout tone="error">{signOutAction.error}</Callout>
			)}
			<Outlet />
		</AppShell>
	)
}

export function RouteError({ error }: ErrorComponentProps): React.JSX.Element {
	const router = useRouter()
	if (isSignedOut(error)) {
		return <Navigate to="/sign-in" search={signInSearch(router.state.location.href)} replace />
	}
	return (
		<div className="space-y-3">
			<Callout tone="error">{errorMessage(error)}</Callout>
			<Button variant="outline" size="sm" onClick={() => void router.invalidate()}>
				Try again
			</Button>
		</div>
	)
}
