import { useEffect } from "react"

export function useMountEffect(effect: () => void | (() => void)): void {
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount by design; callers key the component to rerun it
	useEffect(effect, [])
}
