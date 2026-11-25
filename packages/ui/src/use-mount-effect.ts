import { useEffect, useRef } from "react"

export function useMountEffect(effect: () => void | (() => void)): void {
	const initial = useRef(effect)
	useEffect(() => initial.current(), [])
}
