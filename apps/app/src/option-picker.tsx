import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { Select } from "@checkfu/ui/input"
import type * as React from "react"
import { errorMessage, isSignedOut } from "./api.ts"
import type { Selection } from "./selection.ts"

export interface Choices<T> {
	readonly items: ReadonlyArray<T>
	readonly pending: boolean
	readonly error: string | undefined
	readonly more: (() => void) | null
}

export const choicesOf = <T,>(query: {
	readonly data: { readonly pages: ReadonlyArray<{ readonly data: ReadonlyArray<T> }> }
	readonly isFetchingNextPage: boolean
	readonly error: unknown
	readonly hasNextPage: boolean
	readonly fetchNextPage: () => Promise<{ readonly isError: boolean }>
}): Choices<T> => ({
	items: query.data.pages.flatMap((page) => page.data),
	pending: query.isFetchingNextPage,
	error: query.error === null || isSignedOut(query.error) ? undefined : errorMessage(query.error),
	more: query.hasNextPage ? () => void query.fetchNextPage() : null,
})

export function OptionPicker<T extends { readonly id: string }>({
	label,
	noun,
	placeholder,
	options,
	value,
	onChange,
	describe,
}: {
	readonly label: string
	readonly noun: string
	readonly placeholder: string
	readonly options: Choices<T>
	readonly value: Selection
	readonly onChange: (id: string) => void
	readonly describe: (option: T) => string
}): React.JSX.Element {
	return (
		<div className="space-y-2">
			<Field
				label={label}
				error={
					value.gone
						? `The ${label.toLowerCase()} you chose is no longer available. Choose another.`
						: undefined
				}
			>
				<Select required value={value.id} onChange={(event) => onChange(event.target.value)}>
					{value.id === "" ? (
						<option value="" disabled>
							{placeholder}
						</option>
					) : null}
					{options.items.map((option) => (
						<option key={option.id} value={option.id}>
							{describe(option)}
						</option>
					))}
				</Select>
			</Field>
			{options.more === null ? null : (
				<Button variant="ghost" size="sm" disabled={options.pending} onClick={options.more}>
					Load more {noun}
				</Button>
			)}
			{options.error === undefined ? null : <Callout tone="error">{options.error}</Callout>}
		</div>
	)
}
