import { Button } from "@checkfu/ui/button"
import { Field } from "@checkfu/ui/field"
import { Input } from "@checkfu/ui/input"
import { useInfiniteQuery } from "@tanstack/react-query"
import type { ChangeEventHandler } from "react"
import { useDeferredValue, useId, useState } from "react"
import { modelSuggestionsQuery } from "./queries.ts"

export function ModelField({
	value,
	onChange,
}: {
	readonly value: string
	readonly onChange: ChangeEventHandler<HTMLInputElement>
}) {
	const optionsId = useId()
	const [active, setActive] = useState(false)
	const deferred = useDeferredValue(value)
	const query = useInfiniteQuery({ ...modelSuggestionsQuery(deferred.trim()), enabled: active })
	const current = active && deferred === value
	const ids = current
		? new Set(query.data?.pages.flatMap(({ data }) => data.map(({ id }) => id)))
		: new Set<string>()
	return (
		<div className="space-y-1">
			<Field
				label="Model"
				description="Choose a suggestion or enter a model ID configured for this deployment."
			>
				<Input
					required
					autoComplete="off"
					list={optionsId}
					value={value}
					onFocus={() => setActive(true)}
					onChange={onChange}
					className="font-mono"
				/>
			</Field>
			<datalist id={optionsId}>
				{[...ids].map((id) => (
					<option key={id} value={id} />
				))}
			</datalist>
			{current && query.isError ? (
				<div className="flex items-center gap-2 text-xs">
					<span role="status">Could not load model suggestions.</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() =>
							void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())
						}
					>
						Retry
					</Button>
				</div>
			) : null}
			{current && query.hasNextPage ? (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={query.isFetchingNextPage}
					onClick={() => void query.fetchNextPage()}
				>
					Load more models
				</Button>
			) : null}
		</div>
	)
}
