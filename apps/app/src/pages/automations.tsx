import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Field } from "@checkfu/ui/field"
import { shortId, timeAgo } from "@checkfu/ui/format"
import { Input, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList, PageHeader } from "@checkfu/ui/page-header"
import { DataTable } from "@checkfu/ui/table"
import type { JsonAutomation } from "@checkfu/sdk/client"
import { useQuery, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { PlusIcon } from "lucide-react"
import { useState } from "react"
import type * as React from "react"
import { checkfu, errorMessage, isSignedOut, saveAutomationEdit } from "../api.ts"
import type { AutomationEditReview, JsonAutomationRun } from "../api.ts"
import {
	createBodyOf,
	draftOf,
	emptyDraft,
	firingLabel,
	localTimezone,
	messageOf,
	rebaseDraft,
} from "../automation-draft.ts"
import type { AutomationDraft } from "../automation-draft.ts"
import { choicesOf, OptionPicker } from "../option-picker.tsx"
import type { Choices } from "../option-picker.tsx"
import { Pager } from "../pager.tsx"
import {
	agentChoices,
	agentQuery,
	automationQuery,
	automationRunsQuery,
	automationsPage,
	environmentChoices,
	present,
} from "../queries.ts"
import { selection } from "../selection.ts"
import { Status } from "../status.tsx"
import { useAction, useSubmissionKey } from "../use-action.ts"

const list = getRouteApi("/_app/automations/")
const detail = getRouteApi("/_app/automations/$automationId")

export function AutomationsPage(): React.JSX.Element {
	const search = list.useSearch()
	const page = useSuspenseQuery(automationsPage(search.page)).data
	return (
		<>
			<PageHeader
				title="Automations"
				description="Agents that start a session on a schedule."
				actions={
					<Button size="sm" asChild>
						<Link to="/automations/new">
							<PlusIcon /> New automation
						</Link>
					</Button>
				}
			/>
			<DataTable
				rows={page.data}
				rowKey={(automation) => automation.id}
				empty="No automations yet."
				columns={[
					{
						key: "name",
						header: "Name",
						cell: (automation) => (
							<Link
								to="/automations/$automationId"
								params={{ automationId: automation.id }}
								className="hover:underline"
							>
								{automation.name}
							</Link>
						),
					},
					{
						key: "schedule",
						header: "Schedule",
						cell: (automation) => <Schedule automation={automation} />,
					},
					{
						key: "status",
						header: "Status",
						cell: (automation) => <Status status={automation.status} />,
					},
					{
						key: "next",
						header: "Next run",
						cell: (automation) => {
							const next = automation.upcoming_runs_at[0]
							return next === undefined ? "—" : firingLabel(next, automation.schedule.timezone)
						},
						className: "text-muted-foreground",
					},
					{
						key: "last",
						header: "Last run",
						cell: (automation) =>
							automation.last_run_at === null ? "Never" : timeAgo(automation.last_run_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			<Pager next={page.next_page} paged={search.page !== undefined} />
		</>
	)
}

function Schedule({ automation }: { readonly automation: JsonAutomation }): React.JSX.Element {
	return (
		<span>
			<span className="font-mono">{automation.schedule.expression}</span>{" "}
			<span className="text-muted-foreground">{automation.schedule.timezone}</span>
		</span>
	)
}

interface Option {
	readonly id: string
	readonly label: string
}

const withCurrent = (choices: Choices<Option>, current: string, noun: string): Choices<Option> =>
	current === "" || choices.items.some((option) => option.id === current)
		? choices
		: {
				...choices,
				items: [{ id: current, label: `Current ${noun} (${shortId(current)})` }, ...choices.items],
			}

function AutomationForm({
	draft,
	onChange,
	submitLabel,
	pending,
	error,
	onSubmit,
	onCancel,
	saved,
}: {
	readonly draft: AutomationDraft
	readonly onChange: (draft: AutomationDraft) => void
	readonly submitLabel: string
	readonly pending: boolean
	readonly error: string | undefined
	readonly onSubmit: (draft: AutomationDraft) => void
	readonly onCancel?: () => void
	readonly saved?: { readonly agentId: string; readonly environmentId: string }
}): React.JSX.Element {
	const agentChoicesPage = choicesOf(useSuspenseInfiniteQuery(agentChoices))
	const environmentChoicesPage = choicesOf(useSuspenseInfiniteQuery(environmentChoices))
	const agentOptions = withCurrent(
		{
			...agentChoicesPage,
			items: agentChoicesPage.items.map((agent) => ({
				id: agent.id,
				label: `${agent.name} (${agent.model.id})`,
			})),
		},
		saved?.agentId ?? "",
		"agent",
	)
	const environmentOptions = withCurrent(
		{
			...environmentChoicesPage,
			items: environmentChoicesPage.items.map((environment) => ({
				id: environment.id,
				label: environment.name,
			})),
		},
		saved?.environmentId ?? "",
		"environment",
	)
	const agent = selection(agentOptions.items, draft.agentId === "" ? undefined : draft.agentId)
	const environment = selection(
		environmentOptions.items,
		draft.environmentId === "" ? undefined : draft.environmentId,
	)
	const set = (changes: Partial<AutomationDraft>) => onChange({ ...draft, ...changes })
	if (
		(agentOptions.items.length === 0 && agentOptions.more === null) ||
		(environmentOptions.items.length === 0 && environmentOptions.more === null)
	) {
		return (
			<Callout>
				An automation needs an{" "}
				<Link to="/agents/new" className="underline">
					agent
				</Link>{" "}
				and an{" "}
				<Link to="/environments/new" className="underline">
					environment
				</Link>
				.
			</Callout>
		)
	}
	return (
		<form
			className="max-w-2xl"
			onSubmit={(event) => {
				event.preventDefault()
				onSubmit({ ...draft, agentId: agent.id, environmentId: environment.id })
			}}
		>
			<fieldset disabled={pending} className="min-w-0 space-y-4">
				<Field label="Name">
					<Input
						required
						value={draft.name}
						onChange={(event) => set({ name: event.target.value })}
					/>
				</Field>
				<Field label="Description">
					<Input
						value={draft.description}
						onChange={(event) => set({ description: event.target.value })}
					/>
				</Field>
				<OptionPicker
					label="Agent"
					noun="agents"
					placeholder="Choose an agent"
					options={agentOptions}
					value={agent}
					onChange={(agentId) => set({ agentId })}
					describe={(option) => option.label}
				/>
				<OptionPicker
					label="Environment"
					noun="environments"
					placeholder="Choose an environment"
					options={environmentOptions}
					value={environment}
					onChange={(environmentId) => set({ environmentId })}
					describe={(option) => option.label}
				/>
				<Field label="Message" description="What each run's session starts with.">
					<Textarea
						required
						value={draft.message}
						onChange={(event) => set({ message: event.target.value })}
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						label="Schedule"
						description="A five-field cron expression that names one minute, such as 0 9 * * 1-5."
					>
						<Input
							required
							className="font-mono"
							value={draft.expression}
							onChange={(event) => set({ expression: event.target.value })}
						/>
					</Field>
					<Field label="Timezone" description="An IANA name, such as America/New_York.">
						<Input
							required
							value={draft.timezone}
							onChange={(event) => set({ timezone: event.target.value })}
						/>
					</Field>
				</div>
				{error === undefined ? null : <Callout tone="error">{error}</Callout>}
				<div className="flex gap-2">
					<Button type="submit" disabled={pending || agent.id === "" || environment.id === ""}>
						{submitLabel}
					</Button>
					{onCancel === undefined ? null : (
						<Button type="button" variant="outline" onClick={onCancel}>
							Cancel
						</Button>
					)}
				</div>
			</fieldset>
		</form>
	)
}

export function NewAutomationPage(): React.JSX.Element {
	const navigate = useNavigate()
	const agents = useSuspenseInfiniteQuery(agentChoices).data.pages.flatMap((page) => page.data)
	const environments = useSuspenseInfiniteQuery(environmentChoices).data.pages.flatMap(
		(page) => page.data,
	)
	const [draft, setDraft] = useState(() => ({
		...emptyDraft(localTimezone()),
		agentId: agents[0]?.id ?? "",
		environmentId: environments[0]?.id ?? "",
	}))
	const createKey = useSubmissionKey()
	const create = useAction(
		async (submitted: AutomationDraft) => {
			const body = createBodyOf(submitted)
			const automation = await checkfu.automations.create(body, createKey.keyFor(body))
			createKey.settle()
			return automation
		},
		{
			invalidates: [["automations"]],
			then: (automation) =>
				void navigate({
					to: "/automations/$automationId",
					params: { automationId: automation.id },
				}),
		},
	)
	return (
		<>
			<PageHeader title="New automation" breadcrumb={<Link to="/automations">Automations</Link>} />
			<AutomationForm
				draft={draft}
				onChange={setDraft}
				submitLabel="Create automation"
				pending={create.pending}
				error={create.error}
				onSubmit={(submitted) => create.run(submitted)}
			/>
		</>
	)
}

export function AutomationPage(): React.JSX.Element {
	const { automationId } = detail.useParams()
	const automation = present(useSuspenseQuery(automationQuery(automationId)))
	return <AutomationView key={automation.id} automation={automation} />
}

interface Edit {
	readonly base: JsonAutomation
	readonly draft: AutomationDraft
	readonly review?: AutomationEditReview
}

const invalidates = [["automations"]] as const

function AutomationEditor({
	initial,
	onClose,
}: {
	readonly initial: JsonAutomation
	readonly onClose: () => void
}): React.JSX.Element {
	const [edit, setEdit] = useState<Edit>(() => ({ base: initial, draft: draftOf(initial) }))
	const save = useAction(saveAutomationEdit, {
		invalidates,
		then: (review, base, submitted) => {
			if (review === undefined) {
				onClose()
				return
			}
			setEdit({
				base: review.latest,
				draft: rebaseDraft(draftOf(base), submitted, draftOf(review.latest)),
				review,
			})
		},
	})
	return (
		<>
			{edit.review === undefined ? null : (
				<Callout tone="error" className="mb-4 max-w-2xl">
					{edit.review.conflicts.length === 0 ? (
						<p>The automation changed again while saving. Your edits are still here.</p>
					) : (
						<>
							<p>
								These fields changed while you were editing. Review the latest values before saving
								your edits.
							</p>
							<ul className="mt-2 space-y-1">
								{edit.review.conflicts.map(({ label, value }) => (
									<li key={label} className="break-words">
										<strong>{label}</strong>{" "}
										<span className="whitespace-pre-wrap">{value || "None"}</span>
									</li>
								))}
							</ul>
						</>
					)}
				</Callout>
			)}
			<AutomationForm
				saved={{ agentId: edit.base.agent.id, environmentId: edit.base.environment_id }}
				draft={edit.draft}
				onChange={(draft) => setEdit({ ...edit, draft })}
				submitLabel={edit.review === undefined ? "Save" : "Save my edits"}
				pending={save.pending}
				error={save.error}
				onSubmit={(submitted) => save.run(edit.base, submitted)}
				onCancel={onClose}
			/>
		</>
	)
}

export function AutomationView({
	automation,
}: {
	readonly automation: JsonAutomation
}): React.JSX.Element {
	const [editBase, setEditBase] = useState<JsonAutomation | null>(null)
	const [queuedRun, setQueuedRun] = useState<number | null>(null)
	const runNow = useAction(() => checkfu.automations.run(automation.id), {
		invalidates,
		then: (started) => setQueuedRun(started.listed === null ? started.run : null),
	})
	const pause = useAction(() => checkfu.automations.pause(automation.id), { invalidates })
	const unpause = useAction(() => checkfu.automations.unpause(automation.id), { invalidates })
	const archive = useAction(() => checkfu.automations.archive(automation.id), { invalidates })
	const archived = automation.status === "archived"
	const agent = useQuery({
		...agentQuery(automation.agent.id),
		enabled: !archived && editBase === null,
	})
	const newerVersion =
		!archived &&
		agent.isSuccess &&
		agent.data.archived_at === null &&
		agent.data.version > automation.agent.version
			? agent.data.version
			: undefined
	const repin = useAction(
		(version: number) =>
			checkfu.automations.update(automation.id, {
				agent: { type: "agent", id: automation.agent.id, version },
				revision: automation.revision,
			}),
		{ invalidates },
	)
	const busy =
		runNow.pending || pause.pending || unpause.pending || archive.pending || repin.pending
	const error = runNow.error ?? pause.error ?? unpause.error ?? archive.error
	return (
		<>
			<PageHeader
				title={automation.name}
				id={automation.id}
				breadcrumb={<Link to="/automations">Automations</Link>}
				accessory={<Status status={automation.status} />}
				description={automation.description ?? undefined}
				actions={
					archived || editBase !== null ? undefined : (
						<>
							<Button size="sm" disabled={busy} onClick={() => runNow.run()}>
								Run now
							</Button>
							{automation.status === "paused" ? (
								<Button variant="outline" size="sm" disabled={busy} onClick={() => unpause.run()}>
									Resume
								</Button>
							) : (
								<Button variant="outline" size="sm" disabled={busy} onClick={() => pause.run()}>
									Pause
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								disabled={repin.pending}
								onClick={() => setEditBase(automation)}
							>
								Edit
							</Button>
							<Button variant="destructive" size="sm" disabled={busy} onClick={() => archive.run()}>
								Archive
							</Button>
						</>
					)
				}
			/>
			{error === undefined ? null : <Callout tone="error">{error}</Callout>}
			{repin.error === undefined ? null : <Callout tone="error">{repin.error}</Callout>}
			{queuedRun === null ? null : (
				<Callout>
					Run #{queuedRun} is queued and not listed yet. It will appear under Runs once it starts;
					reload to check rather than running it again.
				</Callout>
			)}
			{editBase === null ? (
				<>
					<AutomationDetails
						automation={automation}
						repin={
							newerVersion === undefined ? undefined : (
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => repin.run(newerVersion)}
								>
									Use v{newerVersion}
								</Button>
							)
						}
					/>
					<AutomationRuns automation={automation} />
				</>
			) : (
				<AutomationEditor initial={editBase} onClose={() => setEditBase(null)} />
			)}
		</>
	)
}

function AutomationDetails({
	automation,
	repin,
}: {
	readonly automation: JsonAutomation
	readonly repin?: React.ReactNode
}): React.JSX.Element {
	const zone = automation.schedule.timezone
	return (
		<>
			{automation.status === "paused" && automation.pause_reason !== "manual" ? (
				<Callout>
					This automation paused itself ({automation.pause_reason}). Fix its agent or environment,
					then resume it.
				</Callout>
			) : null}
			<DescriptionList>
				<Description label="Agent">
					<Link
						to="/agents/$agentId"
						params={{ agentId: automation.agent.id }}
						search={{ version: automation.agent.version }}
						className="hover:underline"
					>
						{shortId(automation.agent.id)}
					</Link>{" "}
					<span className="text-muted-foreground">pinned to v{automation.agent.version}</span>{" "}
					{repin}
				</Description>
				<Description label="Environment">
					<Link
						to="/environments/$environmentId"
						params={{ environmentId: automation.environment_id }}
						className="hover:underline"
					>
						{shortId(automation.environment_id)}
					</Link>
				</Description>
				<Description label="Schedule">
					<Schedule automation={automation} />
				</Description>
				<Description label="Next runs">
					{automation.upcoming_runs_at.length === 0 ? (
						"None"
					) : (
						<ul className="space-y-0.5">
							{automation.upcoming_runs_at.map((at) => (
								<li key={at}>{firingLabel(at, zone)}</li>
							))}
						</ul>
					)}
				</Description>
				<Description label="Runs">{automation.run_count}</Description>
				<Description label="Last run">
					{automation.last_run_at === null ? "Never" : timeAgo(automation.last_run_at)}
				</Description>
				<Description label="Created">{timeAgo(automation.created_at)}</Description>
			</DescriptionList>
			<section className="space-y-2">
				<h2 className="text-sm font-medium">Message</h2>
				<pre className="rounded-lg border bg-muted/40 p-4 text-control whitespace-pre-wrap">
					{messageOf(automation)}
				</pre>
			</section>
		</>
	)
}

function AutomationRuns({
	automation,
}: {
	readonly automation: JsonAutomation
}): React.JSX.Element {
	const runs = useSuspenseInfiniteQuery(automationRunsQuery(automation.id))
	const rows = runs.data.pages.flatMap((page) => page.data)
	return (
		<section className="space-y-2">
			<h2 className="text-sm font-medium">Runs</h2>
			<DataTable
				rows={rows}
				rowKey={(run) => String(run.run)}
				empty="No runs yet."
				columns={[
					{ key: "run", header: "Run", cell: (run) => `#${run.run}` },
					{
						key: "trigger",
						header: "Trigger",
						cell: (run: JsonAutomationRun) =>
							run.trigger.type === "manual"
								? "On request"
								: `Scheduled for ${firingLabel(run.trigger.scheduled_at, automation.schedule.timezone)}`,
					},
					{ key: "status", header: "Status", cell: (run) => <Status status={run.status} /> },
					{
						key: "session",
						header: "Session",
						cell: (run) =>
							run.session_id === null ? (
								<span className="text-muted-foreground">{run.error?.message ?? "—"}</span>
							) : (
								<Link
									to="/sessions/$sessionId"
									params={{ sessionId: run.session_id }}
									className="font-mono text-xs hover:underline"
								>
									{shortId(run.session_id)}
								</Link>
							),
					},
					{
						key: "when",
						header: "When",
						cell: (run) => timeAgo(run.created_at),
						className: "text-muted-foreground",
					},
				]}
			/>
			{runs.hasNextPage ? (
				<Button
					variant="outline"
					size="sm"
					disabled={runs.isFetchingNextPage}
					onClick={() => void runs.fetchNextPage()}
				>
					Older runs
				</Button>
			) : null}
			{runs.isFetchNextPageError && !isSignedOut(runs.error) ? (
				<Callout tone="error">{errorMessage(runs.error)}</Callout>
			) : null}
		</section>
	)
}
