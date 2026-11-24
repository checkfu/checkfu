import { MoonIcon, SunIcon } from "lucide-react"
import * as React from "react"
import { Button } from "./button.tsx"
import { STORAGE_KEY } from "./theme-script.ts"

type Theme = "light" | "dark"

const CHANGE_EVENT = "checkfu:theme"

const read = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light")

const subscribe = (onChange: () => void): (() => void) => {
	window.addEventListener(CHANGE_EVENT, onChange)
	return () => window.removeEventListener(CHANGE_EVENT, onChange)
}

const apply = (theme: Theme): void => {
	const root = document.documentElement
	root.classList.remove("light", "dark")
	root.classList.add(theme)
	root.style.colorScheme = theme
	window.dispatchEvent(new Event(CHANGE_EVENT))
	localStorage.setItem(STORAGE_KEY, theme)
}

export function ThemeToggle(): React.JSX.Element {
	const theme = React.useSyncExternalStore(subscribe, read, () => "light" as const)
	const next = theme === "dark" ? "light" : "dark"
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={`Switch to ${next} theme`}
			onClick={() => apply(next)}
		>
			{theme === "dark" ? <SunIcon /> : <MoonIcon />}
		</Button>
	)
}
