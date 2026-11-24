import { AppShell, NavItem } from "@checkfu/ui/app-shell"
import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Logo } from "@checkfu/ui/logo"
import { ThemeToggle } from "@checkfu/ui/theme"
import { Link, Navigate, Outlet, useNavigate } from "@tanstack/react-router"
import type { ErrorComponentProps } from "@tanstack/react-router"
import { BotIcon, BoxIcon, LogOutIcon, MessagesSquareIcon } from "lucide-react"
import type * as React from "react"
import { errorMessage, isSignedOut, signOut } from "../api.ts"

export function Layout(): React.JSX.Element {
	const navigate = useNavigate()
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
				</>
			}
			footer={
				<>
					<ThemeToggle />
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Sign out"
						onClick={() => {
							void signOut().then(() => navigate({ to: "/sign-in" }))
						}}
					>
						<LogOutIcon />
					</Button>
				</>
			}
		>
			<Outlet />
		</AppShell>
	)
}

export function RouteError({ error, reset }: ErrorComponentProps): React.JSX.Element {
	if (isSignedOut(error)) {
		return <Navigate to="/sign-in" />
	}
	return (
		<div className="mx-auto max-w-xl space-y-3 p-8">
			<Callout tone="error">{errorMessage(error)}</Callout>
			<Button variant="outline" size="sm" onClick={reset}>
				Try again
			</Button>
		</div>
	)
}
