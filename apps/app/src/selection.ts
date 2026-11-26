export interface Selection {
	readonly id: string
	readonly gone: boolean
}

export const selection = (
	options: ReadonlyArray<{ readonly id: string }>,
	chosen: string | undefined,
): Selection =>
	chosen === undefined
		? { id: options[0]?.id ?? "", gone: false }
		: options.some((option) => option.id === chosen)
			? { id: chosen, gone: false }
			: { id: "", gone: true }

export const reconcile = (
	chosen: ReadonlyArray<string>,
	offered: ReadonlyArray<{ readonly id: string }>,
) => {
	const ids = new Set(offered.map((option) => option.id))
	return {
		kept: chosen.filter((id) => ids.has(id)),
		gone: chosen.filter((id) => !ids.has(id)),
	}
}
