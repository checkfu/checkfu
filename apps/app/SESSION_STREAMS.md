# Browser session stream liveness

The dashboard uses native EventSource and delays its reconnect notice for five seconds after a reported transport error. EventSource exposes stream events and connection errors. Comment keepalives are consumed by the browser.

The production dashboard build was run against a local stream fixture in Chrome 158. Each scenario first displayed sequence 901.

| Transport | Observation | Result |
| --- | --- | --- |
| Open response with no further bytes | 6,505 ms | EventSource remained open without an error or reconnect notice. |
| Open response with comment keepalives | 6,517 ms and 21 comments | EventSource remained open without an error or reconnect notice. |
| Abrupt socket close | Reopened in 107 ms with the fixture’s 100 ms retry interval | EventSource emitted an error and resumed with `Last-Event-ID: 901`. The brief interruption stayed below the notice delay. |

These measurements distinguish a reported disconnect from an apparently open connection. Native EventSource offered the dashboard no signal that could distinguish the first two cases in the measured interval.

Keep native EventSource. If silent connections become a service problem, an observable heartbeat can provide a signal without changing the durable event sequence. A byte-aware stream reader could observe existing comments but would need to own reconnection, framing, and HTTP status handling. Either change needs a bounded recovery test for a silent stream, quiet healthy sessions, exact cursor resumption, authentication rechecks, and the session route’s bundle budget.

Rerun the three scenarios with `bun run --cwd apps/app build` and `CHROME_PATH=/path/to/chrome bun apps/app/test/profile-transcript-browser.ts --liveness`.
