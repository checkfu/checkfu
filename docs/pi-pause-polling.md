# Pi pause detection measurements

## Method

Measured on November 26, 2026 on an Apple M1 Max running arm64 macOS, with Node 24.22.3, Bun 1.4.2, Vitest 5.1.1, Effect 4.1.5, and Pi Durable 1.6.0. Bun launches the Node test runner. The fixture runs the production turn engine against Pi Durable's in-memory storage with a controlled model response and a controlled tool call. Recovery interrupts the first waiter and starts a new waiter through `recoverPiDurableTurn` against the same admitted submission. The fixture makes no external requests.

```sh
CHECKFU_MEASURE_PAUSE=1 bun run --cwd apps/api test \
  test/PiDurableEngine.test.ts test/PiActions.test.ts --maxWorkers=1 \
  -t 'counts pause polling|settles or cancels a|counts a pending ordinary tool|detects a parked action|measures real pause wakeup latency' \
  --reporter=verbose
```

The held-model timing run takes about five minutes.

```sh
CHECKFU_MEASURE_PAUSE=1 bun run --cwd apps/api test \
  test/PiDurableEngine.test.ts --maxWorkers=1 \
  -t 'measures real pending polling cost' --reporter=verbose
```

The virtual-time runs advance the actual 100 ms timer by 1, 10, and 30 seconds while a model or an ordinary tool is held. They count wait calls, submission lookups at the in-memory storage boundary, harness inspections, storage task scans, wait-signal aborts, and turn aborts. The starting snapshot separates reads made through admission, recovery, and the first backend wait from the reads made while polling.

The held-model real-time runs take cumulative samples at 1, 10, and 30 seconds across five independent waits per path. The custom-action real-time runs release a scripted model response requesting the tool 10, 90, or 110 ms after the waiter starts. The native commit observer timestamps the stored sleeping-task transition using `performance.now()`. Wakeup ends when the engine returns the paused outcome. Each timing cell has five repetitions. `process.cpuUsage()` covers the test process, including the fixture and its observers. Whole-process timings include work beyond polling and do not isolate its CPU cost. Ordinary-tool CPU was not measured separately.

## Baseline measurements

Both paths call `wait` once. Through entry to the wait, the fresh path makes three submission reads and recovery makes two. During a held model or ordinary tool, both paths produced the same counts below. Each elapsed timer opportunity generated one submission read and one inspection. The fixture recorded zero storage task scans or aborts in those intervals. Cloudflare SQLite I/O and Worker CPU were outside this fixture's instrumentation.

| Virtual wait | Timer opportunities | Submission reads per path and workload | Inspections per path and workload | Storage task scans |
| --- | ---: | ---: | ---: | ---: |
| 1 s | 10 | 10 | 10 | 0 |
| 10 s | 100 | 100 | 100 | 0 |
| 30 s | 300 | 300 | 300 | 0 |

The held-model real-time rows record a submission read and an inspection for each completed tick. Each run made one wait call and no storage task scans or aborts. Real-time counts ran below the ideal virtual schedule. The loop starts each timer after the preceding reads and actual timer scheduling adds overhead. CPU is cumulative since wait start and includes fixture overhead.

| Path | Target | Samples | Reads and inspections each | Median process CPU (ms) | Process CPU range (ms) |
| --- | ---: | ---: | ---: | ---: | --- |
| fresh | 1 s | 5 | 9–9 | 3.937 | 2.206–7.421 |
| fresh | 10 s | 5 | 98–98 | 27.083 | 23.693–165.404 |
| fresh | 30 s | 5 | 295–295 | 89.944 | 74.075–316.669 |
| recovery | 1 s | 5 | 9–9 | 2.507 | 2.262–4.209 |
| recovery | 10 s | 5 | 98–98 | 22.651 | 20.584–26.713 |
| recovery | 30 s | 5 | 295–295 | 66.361 | 63.058–101.519 |

| Path | Target | Run | Elapsed (ms) | Reads and inspections each | User CPU (µs) | System CPU (µs) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fresh | 1 s | 1 | 1001.814 | 9 | 6890 | 531 |
| fresh | 10 s | 1 | 10000.555 | 98 | 147999 | 17405 |
| fresh | 30 s | 1 | 30000.479 | 295 | 290991 | 25678 |
| fresh | 1 s | 2 | 1000.245 | 9 | 3772 | 165 |
| fresh | 10 s | 2 | 10002.759 | 98 | 25660 | 1423 |
| fresh | 30 s | 2 | 30004.297 | 295 | 81003 | 4517 |
| fresh | 1 s | 3 | 1001.388 | 9 | 4225 | 391 |
| fresh | 10 s | 3 | 10001.205 | 98 | 27485 | 2198 |
| fresh | 30 s | 3 | 30001.849 | 295 | 84472 | 5472 |
| fresh | 1 s | 4 | 999.887 | 9 | 2447 | 132 |
| fresh | 10 s | 4 | 10002.297 | 98 | 22162 | 1531 |
| fresh | 30 s | 4 | 30001.438 | 295 | 97785 | 9702 |
| fresh | 1 s | 5 | 1002.021 | 9 | 2073 | 133 |
| fresh | 10 s | 5 | 10002.475 | 98 | 22497 | 1665 |
| fresh | 30 s | 5 | 30001.933 | 295 | 69849 | 4226 |
| recovery | 1 s | 1 | 1001.610 | 9 | 3865 | 344 |
| recovery | 10 s | 1 | 10002.666 | 98 | 24980 | 1733 |
| recovery | 30 s | 1 | 30002.532 | 295 | 62640 | 3845 |
| recovery | 1 s | 2 | 1000.799 | 9 | 2351 | 156 |
| recovery | 10 s | 2 | 10000.855 | 98 | 20716 | 1176 |
| recovery | 30 s | 2 | 30002.573 | 295 | 96456 | 5063 |
| recovery | 1 s | 3 | 1001.908 | 9 | 2102 | 160 |
| recovery | 10 s | 3 | 10002.507 | 98 | 18977 | 1607 |
| recovery | 30 s | 3 | 30001.278 | 295 | 59051 | 4007 |
| recovery | 1 s | 4 | 1001.863 | 9 | 2807 | 179 |
| recovery | 10 s | 4 | 10002.681 | 98 | 21544 | 1375 |
| recovery | 30 s | 4 | 30003.012 | 295 | 62496 | 3865 |
| recovery | 1 s | 5 | 1000.211 | 9 | 2244 | 163 |
| recovery | 10 s | 5 | 10003.252 | 98 | 21333 | 1318 |
| recovery | 30 s | 5 | 30003.217 | 295 | 61268 | 3784 |

## Pause and cancellation

The custom action's stored sleep at virtual time zero was detected at 100 ms. A sleep at 101 ms, directly after the first inspection, was detected at 200 ms. The outcomes took one and two inspections respectively. They recorded two and three submission reads after wait entry, including the outcome read. Each pause cancelled its wait signal once and left the turn running. Finishing or cancelling at virtual time 99 ms took zero inspections. Finishing made two submission reads after wait entry. Cancelling made five, called the turn abort once, and returned `TurnInterrupted` on both paths.

Real-time wakeup measurements are below. Every run called `wait` once, aborted the wait signal once on pause, and made zero turn aborts and zero storage task scans. The 10 and 90 ms cells each made one inspection and two submission reads after wait entry. The 110 ms cells each made two inspections and three submission reads.

| Path | Action release (ms) | Samples | Median wake (ms) | Wake range (ms) | Process CPU range (ms) |
| --- | ---: | ---: | ---: | --- | --- |
| fresh | 10 | 5 | 89.880 | 88.205–90.101 | 3.055–5.285 |
| fresh | 90 | 5 | 9.207 | 7.556–9.237 | 2.739–6.825 |
| fresh | 110 | 5 | 89.455 | 88.602–93.172 | 4.354–6.297 |
| recovery | 10 | 5 | 88.908 | 86.831–90.642 | 3.380–105.591 |
| recovery | 90 | 5 | 8.023 | 6.651–11.510 | 2.171–5.544 |
| recovery | 110 | 5 | 90.977 | 88.584–93.149 | 2.853–5.092 |

The individual samples are in run order within each cell, with CPU in process-wide microseconds.

| Path | Release (ms) | Run | Stored sleep (ms after wait start) | Wake (ms) | User CPU (µs) | System CPU (µs) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fresh | 10 | 1 | 12.977 | 88.839 | 5029 | 256 |
| fresh | 10 | 2 | 12.567 | 88.205 | 3651 | 170 |
| fresh | 10 | 3 | 12.400 | 89.880 | 3837 | 132 |
| fresh | 10 | 4 | 12.011 | 90.101 | 3827 | 140 |
| fresh | 10 | 5 | 11.344 | 89.910 | 2954 | 101 |
| fresh | 90 | 1 | 93.096 | 7.556 | 3119 | 117 |
| fresh | 90 | 2 | 92.502 | 9.209 | 3898 | 77 |
| fresh | 90 | 3 | 92.370 | 7.676 | 3597 | 76 |
| fresh | 90 | 4 | 92.671 | 9.207 | 2674 | 65 |
| fresh | 90 | 5 | 93.139 | 9.237 | 6596 | 229 |
| fresh | 110 | 1 | 113.149 | 93.172 | 5810 | 255 |
| fresh | 110 | 2 | 112.475 | 90.673 | 5901 | 229 |
| fresh | 110 | 3 | 113.693 | 89.011 | 6111 | 186 |
| fresh | 110 | 4 | 114.186 | 88.602 | 4146 | 242 |
| fresh | 110 | 5 | 113.958 | 89.455 | 4284 | 70 |
| recovery | 10 | 1 | 11.310 | 90.642 | 103412 | 2179 |
| recovery | 10 | 2 | 13.869 | 87.710 | 3411 | 64 |
| recovery | 10 | 3 | 12.838 | 89.469 | 3405 | 65 |
| recovery | 10 | 4 | 12.787 | 88.908 | 3266 | 114 |
| recovery | 10 | 5 | 13.958 | 86.831 | 5858 | 153 |
| recovery | 90 | 1 | 91.071 | 11.510 | 5412 | 132 |
| recovery | 90 | 2 | 93.551 | 8.023 | 4333 | 186 |
| recovery | 90 | 3 | 94.158 | 6.651 | 3208 | 112 |
| recovery | 90 | 4 | 93.771 | 7.304 | 2144 | 27 |
| recovery | 90 | 5 | 92.781 | 9.190 | 2440 | 65 |
| recovery | 110 | 1 | 113.014 | 91.529 | 3503 | 80 |
| recovery | 110 | 2 | 112.484 | 89.730 | 4931 | 161 |
| recovery | 110 | 3 | 112.187 | 90.977 | 4841 | 135 |
| recovery | 110 | 4 | 112.027 | 93.149 | 3679 | 81 |
| recovery | 110 | 5 | 113.313 | 88.584 | 2808 | 45 |

## Decision

Keep the 100 ms polling cadence. A capped doubling interval with delays of 100, 200, 400, and then 500 ms would reduce timer opportunities to 3, 21, and 61 at 1, 10, and 30 seconds. Once the interval reaches 500 ms, a pause just after an inspection could wait nearly that long. The process measurements establish a local baseline. A wider interval needs a demonstrated production benefit and a product latency target. Set that target for showing an open action and measure the deployed storage path before widening the interval.

Pi Durable's commit observer is a candidate for an event-driven wakeup. It must re-evaluate the same readiness predicate for custom tool results and direct MCP tool confirmations. An individual sleeping task can coexist with a running generation or another active tool, so changes to those tasks and submission placement also matter. Ordinary tools should leave the waiter pending. On reopen or recovery, subscribe before the first state inspection and re-read if a commit arrives during inspection. Use the same cancellation and completion race and detach the observer when the waiter ends. The measurements used the observer as a timestamp in one process. A switch needs Workerd evidence that a resumed object observes both action sources, including a pause immediately after an inspection, and that cancellation releases the wait without creating a duplicate answer or preventing a later turn.

Existing Workerd tests cover both action sources and restart recovery in separate cases. [Workerd tests](../apps/api/test/workerd/PiSession.workerd.ts)
