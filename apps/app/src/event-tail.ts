import type { JsonSessionEvent } from "@checkfu/sdk/client"

const FLUSH_MS = 50

export const mergeBySeq = (
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

export class EventBatch {
	private pending: Array<JsonSessionEvent> = []
	private timer: ReturnType<typeof setTimeout> | undefined

	private readonly write: (events: ReadonlyArray<JsonSessionEvent>) => void

	constructor(write: (events: ReadonlyArray<JsonSessionEvent>) => void) {
		this.write = write
	}

	newestSeq(): number {
		return Math.max(0, ...this.pending.map((event) => event.seq))
	}

	buffered(): ReadonlyArray<JsonSessionEvent> {
		return this.pending
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
		if (this.pending.length > 0) {
			const batch = this.pending
			this.pending = []
			this.write(batch)
		}
	}

	dispose(): void {
		this.flush()
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
