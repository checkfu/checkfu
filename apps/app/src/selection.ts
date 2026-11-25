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
