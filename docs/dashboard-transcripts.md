# Long dashboard transcript measurements

## Method

Measured November 26, 2026 on an Apple M1 Max with arm64 macOS. Dashboard assets came from the normal production Vite 8.3.8 build at `b4ed85fd2fc9b78d1fd1a057e157c17ce300f7af` with React and React DOM 19.3.1 and React Compiler 1.0.0. The profiled application entry was `index-BGNEApm9.js` and the session implementation was `sessions-Bx4oBQdv.js`. Browser measurements used headless Chrome 158.0.8127.37 with a 1280-by-900 window. Vitest 5.1.1 used Node 24.22.3 for derive-only measurements, and Bun 1.4.2 ran the commands.

```sh
bun install --frozen-lockfile
bun run --cwd apps/app build
CHROME_PATH="/path/to/chrome-or-chromium" bun apps/app/test/profile-transcript-browser.ts
CHECKFU_MEASURE_DASHBOARD_TRANSCRIPT=1 bun run --cwd apps/app test \
  test/transcript.test.ts test/transcript-view.test.tsx --maxWorkers=1 --reporter=verbose
```

The browser runner serves the compiled dashboard and synthetic API responses from one loopback origin. Each run starts at the real session route and loads 100, 1,000 or 10,000 persisted events through the event history query. It uses 50-event pages for the 100-event case and 100-event pages otherwise. Stable sequence numbers identify each row, tool start and result. In every size the newest page contains an idle event referencing an unanswered tool on the previous page. Each size has a warm-up run and five recorded runs. The runner resets the route and restores the target history size between runs.

Each run appends three persisted events in one EventSource write, pushes a preview start and delta, reconnects with two already-seen events and three new ones, then loads one older page. The local server intentionally sets the EventSource retry interval to 100 ms and verifies the last event ID after reconnect. The fixtures bypass deployed networking and authentication while keeping the real UI, React compiler output, batching, history queries and browser rendering.

`Content` measures from arming the browser observer until the expected rendered row count and edge marker appear. For SSE it includes dispatch from the loopback fixture. For prepend it includes the click, request, response, and rendering. `Frame` waits two browser animation frame callbacks from visible DOM completion as a proxy for presentation latency. It varies with the browser frame phase. Root commits come from the React renderer's commit hook during that interval. Reconnect content and frame timings start after the next stream opens.

## Browser measurements

Five measurements are shown for root commits. Each timing cell reports the median and slowest of the five warmed runs.

| Initial events | Update | History after | Rows | Content median / slowest (ms) | Frame median / slowest (ms) | Root commits |
| ---: | --- | ---: | ---: | --- | --- | --- |
| 100 | append | 100 | 82 | 1.5 / 1.6 | 9.9 / 15.8 | 2, 1, 1, 1, 2 |
| 100 | preview | 100 | 83 | 1.0 / 1.1 | 32.8 / 33.0 | 1, 1, 1, 1, 1 |
| 100 | reconnect | 100 | 85 | 1.2 / 1.3 | 25.3 / 26.3 | 1, 1, 1, 1, 1 |
| 100 | prepend | 150 | 125 | 2.8 / 3.1 | 32.4 / 33.6 | 2, 2, 2, 2, 2 |
| 1,000 | append | 1,000 | 802 | 2.6 / 2.7 | 14.5 / 16.1 | 1, 1, 1, 1, 1 |
| 1,000 | preview | 1,000 | 803 | 2.0 / 2.2 | 32.7 / 33.6 | 1, 1, 1, 1, 1 |
| 1,000 | reconnect | 1,000 | 805 | 2.2 / 2.3 | 24.7 / 25.3 | 1, 1, 1, 1, 1 |
| 1,000 | prepend | 1,100 | 885 | 4.4 / 4.5 | 32.3 / 32.9 | 2, 2, 2, 2, 2 |
| 10,000 | append | 10,000 | 8,002 | 13.8 / 15.8 | 23.4 / 26.6 | 1, 1, 1, 1, 1 |
| 10,000 | preview | 10,000 | 8,003 | 11.3 / 14.0 | 30.1 / 33.7 | 1, 1, 1, 1, 1 |
| 10,000 | reconnect | 10,000 | 8,005 | 15.2 / 16.8 | 27.6 / 28.0 | 1, 1, 1, 1, 1 |
| 10,000 | prepend | 10,100 | 8,085 | 17.2 / 19.2 | 41.0 / 42.2 | 2, 2, 2, 2, 2 |

Raw samples are in run order.

| Initial events | Update | Content (ms) | Frame (ms) | Root commits |
| ---: | --- | --- | --- | --- |
| 100 | append | 1.5, 1.6, 1.5, 1.3, 1.3 | 15.8, 9.9, 9.7, 11.2, 9.9 | 2, 1, 1, 1, 2 |
| 100 | preview | 1.0, 1.1, 1.0, 0.8, 1.0 | 32.6, 33.0, 32.4, 32.8, 33.0 | 1, 1, 1, 1, 1 |
| 100 | reconnect | 1.2, 1.2, 1.2, 1.3, 1.3 | 25.3, 25.8, 24.3, 26.3, 24.7 | 1, 1, 1, 1, 1 |
| 100 | prepend | 2.8, 2.7, 3.1, 2.6, 3.1 | 33.6, 32.5, 32.4, 32.1, 30.6 | 2, 2, 2, 2, 2 |
| 1,000 | append | 2.5, 2.7, 2.6, 2.5, 2.7 | 13.1, 14.9, 13.3, 16.1, 14.5 | 1, 1, 1, 1, 1 |
| 1,000 | preview | 2.1, 2.2, 1.9, 1.9, 2.0 | 33.6, 32.0, 32.7, 32.6, 32.8 | 1, 1, 1, 1, 1 |
| 1,000 | reconnect | 2.2, 2.3, 2.2, 2.0, 2.3 | 25.2, 24.3, 24.7, 25.3, 22.9 | 1, 1, 1, 1, 1 |
| 1,000 | prepend | 4.5, 4.2, 4.3, 4.4, 4.5 | 32.2, 31.8, 32.9, 32.9, 32.3 | 2, 2, 2, 2, 2 |
| 10,000 | append | 13.2, 15.4, 13.8, 12.8, 15.8 | 23.4, 26.6, 23.4, 22.2, 24.8 | 1, 1, 1, 1, 1 |
| 10,000 | preview | 11.3, 14.0, 11.1, 11.1, 12.7 | 32.8, 33.7, 30.1, 21.8, 23.4 | 1, 1, 1, 1, 1 |
| 10,000 | reconnect | 16.8, 15.8, 13.3, 13.5, 15.2 | 28.0, 26.2, 27.9, 26.5, 27.6 | 1, 1, 1, 1, 1 |
| 10,000 | prepend | 17.2, 17.6, 17.0, 16.3, 19.2 | 42.2, 41.0, 39.3, 39.8, 41.5 | 2, 2, 2, 2, 2 |

The disconnect interval includes the fixture's forced 100 ms EventSource retry. It measures from the server closing the stream until the next request reaches the fixture.

| Initial events | Disconnect to next request (ms) | Median (ms) |
| ---: | --- | ---: |
| 100 | 101.9, 101.8, 102.7, 102.0, 102.5 | 102.0 |
| 1,000 | 102.6, 101.8, 102.2, 101.7, 101.2 | 101.8 |
| 10,000 | 102.0, 101.5, 101.9, 102.0, 101.8 | 101.9 |

### Derive-only timings

The Node fixture times the dashboard's batch merge, page flattening and tail combination, then folds tool events. It uses the same histories, append and overlapping payloads, with three warm-up repetitions and five measured repetitions per case. For reconnect, the candidate uses the cached history and prior tool fold if the merged tail preserves its old prefix, including structurally equal events received as new objects. It folds only the new suffix under that condition and falls back to a full fold if the prefix changes. Both paths must produce the same calls, waiting set and unseen IDs. The comparison isolates the calculation from React and layout.

| Initial events | Update | Batch merge and flatten (ms) | Tool fold (ms) | Incremental fold (ms) |
| ---: | --- | --- | --- | --- |
| 100 | append | 0.010, 0.011, 0.008, 0.010, 0.009 | 0.013, 0.010, 0.015, 0.010, 0.010 | — |
| 100 | preview | 0.003, 0.003, 0.005, 0.006, 0.003 | 0.009, 0.010, 0.009, 0.009, 0.011 | — |
| 100 | reconnect | 0.009, 0.007, 0.007, 0.009, 0.007 | 0.026, 0.035, 0.025, 0.021, 0.024 | 0.009, 0.005, 0.005, 0.006, 0.014 |
| 100 | prepend | 0.005, 0.003, 0.005, 0.003, 0.003 | 0.028, 0.030, 0.030, 0.031, 0.032 | — |
| 1,000 | append | 0.022, 0.022, 0.020, 0.021, 0.020 | 0.084, 0.086, 0.101, 0.086, 0.091 | — |
| 1,000 | preview | 0.016, 0.018, 0.016, 0.017, 0.016 | 0.085, 0.087, 0.085, 0.084, 0.085 | — |
| 1,000 | reconnect | 0.040, 0.023, 0.021, 0.020, 0.022 | 0.076, 0.073, 0.074, 0.076, 0.076 | 0.012, 0.011, 0.010, 0.010, 0.010 |
| 1,000 | prepend | 0.022, 0.019, 0.020, 0.034, 0.020 | 0.115, 0.093, 0.091, 0.106, 0.096 | — |
| 10,000 | append | 0.145, 0.129, 0.127, 2.035, 0.139 | 0.696, 0.729, 0.697, 0.894, 1.414 | — |
| 10,000 | preview | 0.120, 0.123, 0.122, 0.134, 0.123 | 0.676, 0.680, 1.186, 0.699, 0.677 | — |
| 10,000 | reconnect | 0.192, 0.257, 0.181, 0.166, 0.155 | 0.773, 0.848, 0.885, 0.741, 0.618 | 0.100, 0.078, 0.079, 0.518, 0.078 |
| 10,000 | prepend | 0.127, 0.126, 0.129, 0.133, 0.128 | 0.556, 0.542, 1.212, 0.657, 0.577 | — |

## Correctness checks

- Focused tests compare the entire sequence order after overlap, require one write per fixture batch, and check that the waiting call is unresolved until the previous page loads. The rendered transcript keeps the preview last and puts the only answer form on the tool it belongs to.
- The browser automatically finds that same tool in the older page. It checks row count and the relevant edge markers for every update. After reconnect and prepending, it compares every visible row marker and its position. The reconnect request carries the browser's last event ID. A separate same-stream check proves that the persisted reply replaces its matching preview.
- The focused waiting tool textarea retained its DOM identity and keyboard focus when an older page was inserted. Its viewport movement was -0.25 px at 100 events, 0.50 px at 1,000 events, 0.50 px at 10,000 events, within the one-CSS-pixel tolerance in each case. Tabbing reached the failure checkbox and then the submit button. Pressing Enter sent a single result for the original waiting tool.

A build with the persisted-message preview cleanup temporarily removed failed the same-stream check. The old preview stayed visible beside the persisted reply. The production build passed.

Any rendering change needs to preserve visible sequence order and the scroll anchor when prepending, the keyboard path and focused row identity, the preview's replacement by the persisted reply, and the waiting call's answer ownership.

## Decision

Keep the existing rendering. At 10,000 events, prepending took 17.2 ms to the expected DOM content at the median. Its slowest two-frame sample was 42.2 ms. Reconnect took 15.2 ms at the median and reached 16.8 ms for content and 28.0 ms for the two-frame sample. Preview updates took 11.3 ms at the median. The slowest content sample across the matrix was 19.2 ms.

The incremental reconnect fold reduced the 10,000-event Node median from 0.773 ms to 0.079 ms, including the candidate's prefix check. The replay suffix contains three new message events. This result describes that workload and is a small part of the elapsed browser time. The candidate leaves the history merge and rendering work in place. Start with a browser CPU profile if repeated DOM completion exceeds 50 ms at the expected loaded history size. A change to history rendering needs a comparison on the affected browser workload and the correctness checks above.
