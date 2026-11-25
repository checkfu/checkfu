import type * as React from "react"
import { cn } from "./cn.ts"

export function Table({ className, ...props }: React.ComponentProps<"table">): React.JSX.Element {
	return (
		<div className="relative w-full overflow-x-auto">
			<table className={cn("w-full caption-bottom text-sm", className)} {...props} />
		</div>
	)
}

export function TableHeader({
	className,
	...props
}: React.ComponentProps<"thead">): React.JSX.Element {
	return <thead className={cn("[&_tr]:border-b", className)} {...props} />
}

export function TableBody({
	className,
	...props
}: React.ComponentProps<"tbody">): React.JSX.Element {
	return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.JSX.Element {
	return <tr className={cn("border-b transition-colors hover:bg-muted/50", className)} {...props} />
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">): React.JSX.Element {
	return (
		<th
			className={cn(
				"h-10 px-2 text-left align-middle text-xs font-normal whitespace-nowrap text-muted-foreground",
				className,
			)}
			{...props}
		/>
	)
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">): React.JSX.Element {
	return <td className={cn("px-2 py-3.5 align-middle whitespace-nowrap", className)} {...props} />
}

export interface Column<Row> {
	readonly key: string
	readonly header: React.ReactNode
	readonly cell: (row: Row) => React.ReactNode
	readonly className?: string
}

export function DataTable<Row>({
	rows,
	rowKey,
	columns,
	empty,
	loading = false,
}: {
	readonly rows: ReadonlyArray<Row>
	readonly rowKey: (row: Row) => string
	readonly columns: ReadonlyArray<Column<Row>>
	readonly empty?: React.ReactNode
	readonly loading?: boolean
}): React.JSX.Element {
	return (
		<Table aria-busy={loading || undefined}>
			<TableHeader>
				<TableRow className="hover:bg-transparent">
					{columns.map((column) => (
						<TableHead key={column.key}>{column.header}</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => (
					<TableRow key={rowKey(row)}>
						{columns.map((column) => (
							<TableCell key={column.key} className={column.className}>
								{column.cell(row)}
							</TableCell>
						))}
					</TableRow>
				))}
				{rows.length === 0 && !loading && empty !== undefined ? (
					<TableRow className="hover:bg-transparent">
						<TableCell
							colSpan={columns.length}
							className="py-12 text-center whitespace-normal text-muted-foreground"
						>
							{empty}
						</TableCell>
					</TableRow>
				) : null}
			</TableBody>
		</Table>
	)
}
