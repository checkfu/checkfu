import type { JsonSession, JsonSessionEvent } from "@checkfu/sdk/client"

const FLUSH_MS = 50

const mergeBySeq = (
	tail: ReadonlyArray<JsonSessionEvent>,
	incoming: ReadonlyArray<JsonSessionEvent>,
): ReadonlyArray<JsonSessionEvent> => {
	const sorted = incoming.toSorted((a, b) => a.seq - b.seq)
	const last = tail.at(-1)?.seq ?? 0
	if ((sorted[0]?.seq ?? 0) > last) {
		return tail.concat(sorted.filter((event, index) => event.seq !== sorted[index - 1]?.seq))
	}
	const bySeq = new Map(tail.map((event) => [event.seq, event]))
	for (const event of sorted) {
		bySeq.set(event.seq, event)
	}
	return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq)
}

export class EventTail {
	private events: ReadonlyArray<JsonSessionEvent> = []
	private pending: Array<JsonSessionEvent> = []
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly listeners = new Set<() => void>()

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	readonly snapshot = (): ReadonlyArray<JsonSessionEvent> => this.events

	newestSeq(): number {
		return Math.max(this.events.at(-1)?.seq ?? 0, ...this.pending.map((event) => event.seq))
	}

	add(events: ReadonlyArray<JsonSessionEvent>): void {
		this.pending.push(...events)
		if (this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), FLUSH_MS)
		}
	}

	flush(): void {
		clearTimeout(this.timer)
		this.timer = undefined
		if (this.pending.length === 0) {
			return
		}
		this.events = mergeBySeq(this.events, this.pending)
		this.pending = []
		for (const listener of this.listeners) {
			listener()
		}
	}

	dispose(): void {
		clearTimeout(this.timer)
		this.timer = undefined
		this.pending = []
	}
}

export const transcriptEvents = (
	history: ReadonlyArray<JsonSessionEvent>,
	tail: ReadonlyArray<JsonSessionEvent>,
): ReadonlyArray<JsonSessionEvent> => {
	const newest = history.at(-1)?.seq ?? 0
	const start = tail.findIndex((event) => event.seq > newest)
	return start === -1 ? history : history.concat(tail.slice(start))
}

const statusOf = (event: JsonSessionEvent): JsonSession["status"] | undefined => {
	switch (event.type) {
		case "session.status_running":
			return "running"
		case "session.status_idle":
			return "idle"
		case "session.status_terminated":
			return "terminated"
		default:
			return undefined
	}
}

const turnOf = (event: JsonSessionEvent): number | undefined =>
	event.type === "session.status_running" && "turn" in event && typeof event.turn === "number"
		? event.turn
		: undefined

const latest = <T>(
	events: ReadonlyArray<JsonSessionEvent>,
	read: (event: JsonSessionEvent) => T | undefined,
	fallback: T,
): T => {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]
		const value = event === undefined ? undefined : read(event)
		if (value !== undefined) {
			return value
		}
	}
	return fallback
}

export const progressOf = (
	events: ReadonlyArray<JsonSessionEvent>,
	snapshot: Pick<JsonSession, "status" | "turn">,
): Pick<JsonSession, "status" | "turn"> => ({
	status: latest(events, statusOf, snapshot.status),
	turn: latest(events, turnOf, snapshot.turn),
})
