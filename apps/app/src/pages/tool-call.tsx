import { Button } from "@checkfu/ui/button"
import { Callout } from "@checkfu/ui/callout"
import { Chip } from "@checkfu/ui/chip"
import type { Tone } from "@checkfu/ui/chip"
import { Input, Textarea } from "@checkfu/ui/input"
import { useRef, useState } from "react"
import type * as React from "react"
import { ERROR_CODES } from "@checkfu/sdk/ErrorCodes"
import { ApiError, errorMessage } from "../api.ts"
import { TOOL_REJECTIONS, allowEvent, customResultEvent, denyEvent } from "../tool-calls.ts"
import type { AnswerEvent, ToolCall, ToolCallStatus } from "../tool-calls.ts"
import { useAction, useSubmissionKey } from "../use-action.ts"

export type SendAnswer = (event: AnswerEvent, idempotencyKey: string) => Promise<void>

export const WAITING_REFUSES_MESSAGES =
	"The agent is waiting for answers to its tool calls. Answer them first, then send your message."

export const sendFailure = (error: unknown): Error =>
	error instanceof ApiError && error.code === ERROR_CODES.sessionAwaitingAction
		? new Error(WAITING_REFUSES_MESSAGES)
		: error instanceof Error
			? error
			: new Error(errorMessage(error))

export const NOT_WAITING =
	"This call is no longer waiting: it was already answered, or the turn ended."

export const answerFailure = (error: unknown): Error =>
	error instanceof ApiError && error.status === 409
		? new Error(NOT_WAITING)
		: error instanceof Error
			? error
			: new Error(errorMessage(error))

export const MAX_RESULT_LENGTH = 16_384

const STATUS: Record<ToolCallStatus, { readonly label: string; readonly tone: Tone }> = {
	running: { label: "Running", tone: "blue" },
	waiting: { label: "Waiting on you", tone: "yellow" },
	done: { label: "Done", tone: "gray" },
	error: { label: "Failed", tone: "red" },
	rejected: { label: "Not run", tone: "gray" },
	denied: { label: "Denied", tone: "red" },
	cancelled: { label: "Cancelled", tone: "gray" },
}

const SHORTENED = "Shortened in the log."

const code = (call: ToolCall): string | undefined =>
	call.name === "codemode" && typeof call.input["code"] === "string"
		? call.input["code"]
		: undefined

function Block({
	label,
	children,
	note,
}: {
	readonly label: string
	readonly children: string
	readonly note?: string | undefined
}): React.JSX.Element {
	return (
		<div className="space-y-1">
			<p className="text-meta font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
			<pre className="max-h-80 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-control whitespace-pre-wrap">
				{children}
			</pre>
			{note === undefined ? null : <p className="text-control text-muted-foreground">{note}</p>}
		</div>
	)
}

function useToolAnswer(send: SendAnswer) {
	const [answered, setAnswered] = useState(false)
	const submitted = useRef(false)
	const key = useSubmissionKey()
	const answer = useAction(async (event: AnswerEvent) => {
		try {
			await send(event, key.keyFor(event))
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) {
				setAnswered(true)
			} else {
				submitted.current = false
			}
			throw answerFailure(error)
		}
		key.settle()
		setAnswered(true)
	})
	return {
		disabled: answer.pending || answered,
		error: answer.error,
		run: (event: AnswerEvent) => {
			if (submitted.current) {
				return
			}
			submitted.current = true
			answer.run(event)
		},
	}
}

function Approval({
	call,
	send,
}: {
	readonly call: ToolCall
	readonly send: SendAnswer
}): React.JSX.Element {
	const [reason, setReason] = useState("")
	const answer = useToolAnswer(send)
	return (
		<div className="space-y-2">
			<p className="text-sm">The agent wants to run this call. It waits until you answer.</p>
			<Input
				aria-label="Reason for denying (optional)"
				placeholder="Reason for denying (optional; the agent reads it)"
				value={reason}
				onChange={(event) => setReason(event.target.value)}
			/>
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={answer.disabled}
					onClick={() => answer.run(allowEvent(call.id))}
				>
					Allow
				</Button>
				<Button
					size="sm"
					variant="destructive"
					disabled={answer.disabled}
					onClick={() => answer.run(denyEvent(call.id, reason))}
				>
					Deny
				</Button>
			</div>
			{answer.error === undefined ? null : <Callout tone="error">{answer.error}</Callout>}
		</div>
	)
}

function ClientResult({
	call,
	send,
}: {
	readonly call: ToolCall
	readonly send: SendAnswer
}): React.JSX.Element {
	const [result, setResult] = useState("")
	const [failed, setFailed] = useState(false)
	const answer = useToolAnswer(send)
	const tooLong = result.length > MAX_RESULT_LENGTH
	return (
		<form
			className="space-y-2"
			onSubmit={(event) => {
				event.preventDefault()
				if (!answer.disabled && !tooLong) {
					answer.run(customResultEvent(call.id, result, failed))
				}
			}}
		>
			<p className="text-sm">
				Your application runs this tool. Send its result and the agent carries on.
			</p>
			<Textarea
				aria-label="Result"
				placeholder="What the tool returned"
				value={result}
				onChange={(event) => setResult(event.target.value)}
			/>
			<label className="flex items-center gap-2 text-control">
				<input
					type="checkbox"
					checked={failed}
					onChange={(event) => setFailed(event.target.checked)}
				/>
				The tool failed
			</label>
			{tooLong ? (
				<p className="text-control text-destructive">
					At most {MAX_RESULT_LENGTH.toLocaleString("en-US")} characters.
				</p>
			) : null}
			<Button type="submit" size="sm" disabled={answer.disabled || tooLong}>
				Send result
			</Button>
			{answer.error === undefined ? null : <Callout tone="error">{answer.error}</Callout>}
		</form>
	)
}

function Answered({ call }: { readonly call: ToolCall }): React.JSX.Element | null {
	switch (call.answer?.kind) {
		case "allow":
			return <p className="text-control text-muted-foreground">You allowed this call.</p>
		case "deny":
			return (
				<p className="text-control text-muted-foreground">
					You denied this call{call.answer.message === "" ? "." : `: ${call.answer.message}`}
				</p>
			)
		case "result":
			return (
				<Block
					label={
						call.answer.isError
							? "Your application reported a failure"
							: "Your application answered"
					}
				>
					{call.answer.text === "" ? "(empty)" : call.answer.text}
				</Block>
			)
		case undefined:
			return null
	}
}

export function ToolCallRow({
	call,
	send,
}: {
	readonly call: ToolCall
	readonly send: SendAnswer | undefined
}): React.JSX.Element {
	const status = STATUS[call.status]
	const script = code(call)
	const waiting = call.status === "waiting"
	return (
		<details
			open={waiting}
			className="rounded-md border border-border px-3 py-2 text-control open:pb-3"
		>
			<summary className="flex cursor-pointer items-center gap-2">
				<span className="font-mono">{call.name}</span>
				{call.server === undefined ? null : (
					<span className="text-muted-foreground">on {call.server}</span>
				)}
				{call.kind === "custom" ? (
					<span className="text-muted-foreground">in your application</span>
				) : null}
				<Chip tone={status.tone} live={call.status === "running"} className="ml-auto">
					{status.label}
				</Chip>
			</summary>
			<div className="mt-3 space-y-3">
				{script === undefined ? (
					<Block label="Input" note={call.inputTruncated ? SHORTENED : undefined}>
						{JSON.stringify(call.input, null, 2)}
					</Block>
				) : (
					<Block label="Script" note={call.inputTruncated ? SHORTENED : undefined}>
						{script}
					</Block>
				)}
				{call.askedFirst && call.answer === undefined && !waiting ? (
					<p className="text-control text-muted-foreground">This call needed approval.</p>
				) : null}
				{call.status === "cancelled" ? (
					<p className="text-control text-muted-foreground">
						The turn ended before this call finished.
					</p>
				) : null}
				{call.outcome?.rejected === undefined ? null : (
					<p className="text-control text-muted-foreground">
						This call did not run: {TOOL_REJECTIONS[call.outcome.rejected]}.
					</p>
				)}
				{waiting && send !== undefined ? (
					call.kind === "custom" ? (
						<ClientResult key={call.id} call={call} send={send} />
					) : (
						<Approval key={call.id} call={call} send={send} />
					)
				) : (
					<Answered call={call} />
				)}
				{call.outcome === undefined ? null : (
					<Block
						label={
							call.outcome.rejected !== undefined
								? "What the agent was told"
								: call.outcome.isError
									? "Error"
									: "Result"
						}
						note={call.outcome.truncated ? SHORTENED : undefined}
					>
						{call.outcome.text === "" ? "(empty)" : call.outcome.text}
					</Block>
				)}
			</div>
		</details>
	)
}
