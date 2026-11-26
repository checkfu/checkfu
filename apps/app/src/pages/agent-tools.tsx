import { Button } from "@checkfu/ui/button"
import { Field } from "@checkfu/ui/field"
import { Input, Select, Textarea } from "@checkfu/ui/input"
import { Description, DescriptionList } from "@checkfu/ui/page-header"
import type { JsonAgent } from "@checkfu/sdk/client"
import { PlusIcon, XIcon } from "lucide-react"
import type * as React from "react"
import { isPolicy, newServer, withoutServer, withServer } from "../agent-draft.ts"
import type {
	AgentDraft,
	CustomToolDraft,
	DraftProblems,
	Policy,
	ServerDraft,
} from "../agent-draft.ts"

const POLICY_LABELS: Record<Policy | "", string> = {
	"": "Ask first (default)",
	always_allow: "Always run",
	always_ask: "Always ask first",
}

const EMPTY_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}'

const replaced = <T,>(items: ReadonlyArray<T>, index: number, item: T): ReadonlyArray<T> =>
	items.map((current, at) => (at === index ? item : current))

const without = <T,>(items: ReadonlyArray<T>, index: number): ReadonlyArray<T> =>
	items.filter((_, at) => at !== index)

function Section({
	title,
	description,
	children,
}: {
	readonly title: string
	readonly description: string
	readonly children: React.ReactNode
}): React.JSX.Element {
	return (
		<section className="space-y-3 rounded-lg border p-4">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="text-control text-muted-foreground">{description}</p>
			</div>
			{children}
		</section>
	)
}

function RemoveButton({
	label,
	onClick,
}: {
	readonly label: string
	readonly onClick: () => void
}): React.JSX.Element {
	return (
		<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
			<XIcon />
		</Button>
	)
}

function PolicyFields({
	policy,
	onChange,
}: {
	readonly policy: ServerDraft
	readonly onChange: (policy: ServerDraft) => void
}): React.JSX.Element {
	return (
		<div className="space-y-2 border-l pl-3">
			<Field label="Permissions">
				<Select
					value={policy.fallback}
					onChange={(event) => {
						const value = event.target.value
						onChange({ ...policy, fallback: isPolicy(value) ? value : "" })
					}}
				>
					{(["", "always_ask", "always_allow"] as const).map((value) => (
						<option key={value} value={value}>
							{POLICY_LABELS[value]}
						</option>
					))}
				</Select>
			</Field>
			{policy.overrides.map((override, index) => (
				<div key={index} className="flex items-end gap-2">
					<Field label="Tool" className="flex-1">
						<Input
							required
							placeholder="create_issue"
							value={override.name}
							onChange={(event) =>
								onChange({
									...policy,
									overrides: replaced(policy.overrides, index, {
										...override,
										name: event.target.value,
									}),
								})
							}
							className="font-mono"
						/>
					</Field>
					<Field label="Permission">
						<Select
							value={override.policy}
							onChange={(event) => {
								const value = event.target.value
								onChange({
									...policy,
									overrides: replaced(policy.overrides, index, {
										...override,
										policy: isPolicy(value) ? value : "",
									}),
								})
							}}
						>
							<option value="">Same as the server</option>
							<option value="always_ask">{POLICY_LABELS.always_ask}</option>
							<option value="always_allow">{POLICY_LABELS.always_allow}</option>
						</Select>
					</Field>
					<RemoveButton
						label={`Remove the rule for ${override.name === "" ? "this tool" : override.name}`}
						onClick={() => onChange({ ...policy, overrides: without(policy.overrides, index) })}
					/>
				</div>
			))}
			<Button
				variant="ghost"
				size="sm"
				onClick={() =>
					onChange({
						...policy,
						overrides: [...policy.overrides, { name: "", policy: "always_ask" }],
					})
				}
			>
				<PlusIcon /> Rule for one tool
			</Button>
		</div>
	)
}

function ServerFields({
	server,
	problem,
	onChange,
	onRemove,
}: {
	readonly server: ServerDraft
	readonly problem: string | undefined
	readonly onChange: (server: ServerDraft) => void
	readonly onRemove: () => void
}): React.JSX.Element {
	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex items-end gap-2">
				<Field label="Name" className="w-48" error={problem}>
					<Input
						required
						placeholder="github"
						value={server.name}
						onChange={(event) => onChange({ ...server, name: event.target.value })}
						className="font-mono"
					/>
				</Field>
				<Field label="URL" className="flex-1">
					<Input
						required
						type="url"
						placeholder="https://mcp.example.com/mcp"
						value={server.url}
						onChange={(event) => onChange({ ...server, url: event.target.value })}
						className="font-mono"
					/>
				</Field>
				<RemoveButton
					label={`Remove ${server.name === "" ? "this server" : server.name}`}
					onClick={onRemove}
				/>
			</div>
			<PolicyFields policy={server} onChange={onChange} />
		</div>
	)
}

function CustomToolFields({
	tool,
	problem,
	onChange,
	onRemove,
}: {
	readonly tool: CustomToolDraft
	readonly problem: string | undefined
	readonly onChange: (tool: CustomToolDraft) => void
	readonly onRemove: () => void
}): React.JSX.Element {
	return (
		<div className="space-y-3 rounded-md border p-3">
			<div className="flex items-end gap-2">
				<Field label="Name" className="flex-1" error={problem}>
					<Input
						required
						placeholder="lookup_customer"
						value={tool.name}
						onChange={(event) => onChange({ ...tool, name: event.target.value })}
						className="font-mono"
					/>
				</Field>
				<RemoveButton
					label={`Remove ${tool.name === "" ? "this tool" : tool.name}`}
					onClick={onRemove}
				/>
			</div>
			<Field label="Description">
				<Input
					required
					value={tool.description}
					onChange={(event) => onChange({ ...tool, description: event.target.value })}
				/>
			</Field>
			<Field label="Input schema" description="JSON Schema for the arguments the model sends.">
				<Textarea
					rows={6}
					spellCheck={false}
					value={tool.schema}
					onChange={(event) => onChange({ ...tool, schema: event.target.value })}
					className="font-mono text-xs"
				/>
			</Field>
		</div>
	)
}

export function AgentToolsFields({
	draft,
	problems,
	onChange,
}: {
	readonly draft: AgentDraft
	readonly problems: DraftProblems
	readonly onChange: (draft: AgentDraft) => void
}): React.JSX.Element {
	return (
		<>
			<Section
				title="MCP servers"
				description="Servers whose tools the agent may use. A session binds each to a credential from its vaults."
			>
				{draft.servers.map((server, index) => (
					<ServerFields
						key={server.row}
						server={server}
						problem={problems.servers.get(index)}
						onChange={(next) => onChange(withServer(draft, next))}
						onRemove={() => onChange(withoutServer(draft, server.row))}
					/>
				))}
				<Button
					variant="outline"
					size="sm"
					onClick={() => onChange({ ...draft, servers: [...draft.servers, newServer()] })}
				>
					<PlusIcon /> Add server
				</Button>
			</Section>
			<Section
				title="Custom tools"
				description="Tools your own application runs. The turn waits until your application posts the result."
			>
				{draft.customTools.map((tool, index) => (
					<CustomToolFields
						key={index}
						tool={tool}
						problem={problems.customTools.get(index)}
						onChange={(next) =>
							onChange({ ...draft, customTools: replaced(draft.customTools, index, next) })
						}
						onRemove={() => onChange({ ...draft, customTools: without(draft.customTools, index) })}
					/>
				))}
				<Button
					variant="outline"
					size="sm"
					onClick={() =>
						onChange({
							...draft,
							customTools: [
								...draft.customTools,
								{ name: "", description: "", schema: EMPTY_SCHEMA },
							],
						})
					}
				>
					<PlusIcon /> Add custom tool
				</Button>
			</Section>
		</>
	)
}

const policySummary = (agent: JsonAgent, server: string): string => {
	const toolset = agent.tools.find(
		(tool) => tool.type === "mcp_toolset" && tool.mcp_server_name === server,
	)
	if (toolset === undefined || toolset.type !== "mcp_toolset") {
		return POLICY_LABELS[""]
	}
	const fallback = POLICY_LABELS[toolset.default_config?.permission_policy?.type ?? ""]
	const rules = toolset.configs?.length ?? 0
	return rules === 0 ? fallback : `${fallback}; ${rules} tool rule${rules === 1 ? "" : "s"}`
}

export function AgentToolsSummary({ agent }: { readonly agent: JsonAgent }): React.JSX.Element {
	const custom = agent.tools.flatMap((tool) => (tool.type === "custom" ? [tool] : []))
	return (
		<section className="space-y-2">
			<h2 className="text-sm font-medium">Tools</h2>
			{agent.mcp_servers.length === 0 && custom.length === 0 ? (
				<p className="text-control text-muted-foreground">No MCP servers or custom tools.</p>
			) : (
				<DescriptionList>
					{agent.mcp_servers.map((server) => (
						<Description key={server.name} label={`MCP server ${server.name}`}>
							<span className="font-mono text-xs">{server.url}</span>
							<span className="block text-muted-foreground">
								{policySummary(agent, server.name)}
							</span>
						</Description>
					))}
					{custom.map((tool) => (
						<Description key={tool.name} label={`Custom tool ${tool.name}`}>
							{tool.description}
						</Description>
					))}
				</DescriptionList>
			)}
		</section>
	)
}
