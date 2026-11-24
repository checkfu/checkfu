// The Workers compatibility date every Checkfu Worker runs at. 2026-11-17 turns on
// request.signal by default, so Effect fetch handlers and SSE streams end when the client goes.
export const COMPATIBILITY_DATE = "2026-11-17"

// One owner's traffic is small enough to keep every trace; a failed turn should always have one.
export const TRACE_SAMPLING_RATE = 1
