import type { CreateAgentBody } from "@checkfu/sdk/Api"
import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { CopyButton } from "@checkfu/ui/copy-button"
import { Field } from "@checkfu/ui/field"
import { Textarea } from "@checkfu/ui/input"
import { useState } from "react"
import type { ReactNode } from "react"
import type { AgentSourceCodec, AgentSourceReading } from "./agent-source.ts"
import { useAction } from "./use-action.ts"

export const loadAgentSource = () => import("@checkfu/authoring/document")

export function AgentModeControl({
	showYaml,
	setShowYaml,
	formLabel,
	disabled,
	disableForm,
}: {
	readonly showYaml: boolean
	readonly setShowYaml: (show: boolean) => void
	readonly formLabel: "Form" | "Details"
	readonly disabled?: boolean
	readonly disableForm?: boolean
}) {
	return (
		<div
			role="group"
			aria-label="Agent configuration view"
			className="inline-flex gap-1 rounded-lg border bg-muted/60 p-0.5"
		>
			<Button
				size="sm"
				variant={showYaml ? "ghost" : "outline"}
				disabled={disabled || disableForm}
				aria-pressed={!showYaml}
				onClick={() => setShowYaml(false)}
			>
				{formLabel}
			</Button>
			<Button
				size="sm"
				variant={showYaml ? "outline" : "ghost"}
				disabled={disabled}
				aria-pressed={showYaml}
				onClick={() => setShowYaml(true)}
			>
				YAML
			</Button>
		</div>
	)
}

export function AgentSourceFields({
	text,
	reading,
	touched,
	onChange,
}: {
	readonly text: string
	readonly reading: AgentSourceReading
	readonly touched: boolean
	readonly onChange: (text: string) => void
}) {
	const error = touched ? reading.error : undefined
	return (
		<Field
			label="Agent definition"
			description="Paste YAML, JSON, or Markdown with YAML frontmatter. The same definition works with checkfu apply."
			error={error === undefined ? undefined : <span className="whitespace-pre-wrap">{error}</span>}
		>
			<Textarea
				value={text}
				onChange={(event) => onChange(event.target.value)}
				aria-invalid={error !== undefined}
				spellCheck={false}
				autoCapitalize="off"
				rows={12}
				className="max-h-[32rem] min-h-64 resize-y bg-muted/25 font-mono text-sm"
			/>
		</Field>
	)
}

export function AgentConfigurationView({
	agent,
	children,
}: {
	readonly agent: CreateAgentBody
	readonly children: ReactNode
}) {
	const [showYaml, setShowYaml] = useState(false)
	const [codec, setCodec] = useState<AgentSourceCodec>()
	const load = useAction(loadAgentSource, { then: setCodec })
	const text = showYaml ? codec?.agentDefinitionYaml(agent) : undefined
	return (
		<div className="min-w-0 space-y-3">
			<AgentModeControl
				formLabel="Details"
				showYaml={showYaml}
				setShowYaml={(show) => {
					setShowYaml(show)
					if (show && codec === undefined && !load.pending) {
						load.run()
					}
				}}
			/>
			{showYaml ? (
				<section aria-label="Agent YAML" className="min-w-0 rounded-lg border bg-muted/30">
					{load.error === undefined ? null : <Callout tone="error">{load.error}</Callout>}
					{text === undefined ? (
						load.pending ? (
							<p role="status" className="p-4 text-sm text-muted-foreground">
								Loading YAML…
							</p>
						) : null
					) : (
						<>
							<div className="flex items-center justify-between border-b px-4 py-2">
								<span className="text-sm font-medium">Agent definition</span>
								<CopyButton value={text} label="Copy agent YAML" />
							</div>
							<pre className="max-h-[32rem] overflow-auto p-4 text-control">
								<code>{text}</code>
							</pre>
						</>
					)}
				</section>
			) : (
				<div className="space-y-5">{children}</div>
			)}
		</div>
	)
}
