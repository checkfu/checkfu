# Pi cleanup after unpublished turns

Each admission passes the turn IDs between the last published agent reply and the new turn to the Pi harness. Before submitting the new prompt, the harness acquires the session lock and checks each earlier input. A prior omission uses the stable `omit:turn:<number>` request ID. The harness checks the marker and waits for its submission. When the marker is absent, it reads the old turn's entries, submits the omission using that ID, and waits for it to settle. Publishing an agent message advances the boundary for later admissions. [Turn input view](../packages/domain/src/Session/TurnInput.view.ts) · [Harness](../apps/api/src/Pi/PiDurableHarness.ts) · [Engine](../apps/api/src/Pi/PiDurableEngine.ts)

## Reproduce the measurements

```sh
CHECKFU_MEASURE_PI_CLEANUP=1 bun run --cwd apps/api test test/PiDurableEngine.test.ts --maxWorkers=1 --silent=false -t 'counts cleanup before admission|resumes historical cleanup'
```

The fixture uses a new in-memory backing store and a scripted model for each sample. The first N turns receive deterministic replies internally. The fixture simulates publication of the Nth reply by passing an empty historical range on the next admission. Admission i through N therefore checks i−1 historical candidates. The final admission sees the Nth turn in its prompt. The benchmark records one JSON row per sample with the actual per-turn counts.

| Admitted turns | Historical input lookups in total | Omission marker lookups | Waits on existing omissions | New omission writes | New turn submissions |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 0 | 0 | 0 | 1 |
| 5 | 10 | 14 | 6 | 4 | 5 |
| 10 | 45 | 54 | 36 | 9 | 10 |
| 30 | 435 | 464 | 406 | 29 | 30 |

These are counts from the fixture's backing store, submission waits, and input submissions. An admission with k historical candidates reads k historical inputs. When k is positive it reads k+1 omission markers, including the lookup for the new omission submission, waits on k−1 existing submissions, and writes one new omission. Each admission also reads its own input record five times across admission and settlement. Counting those current-turn reads separately keeps them out of the historical totals. Counts exclude the final admission after publication.

Five samples per streak ran on macOS arm64 with Bun 1.4.2, Node 24.22.3, and one test worker. The fixture uses monotonic `performance.now()`. Admission measures entry into `runPiDurableTurn` until the call to submit its input. Lock time measures the acquired admission permit through return, including that submit. Each value is from the last admission before publishing a reply.

| Streak | Admission samples, ms | Admission median / max, ms | Lock samples, ms | Lock median / max, ms |
| ---: | --- | --- | --- | --- |
| 1 | 8.568, 0.682, 0.516, 0.490, 0.475 | 0.516 / 8.568 | 9.644, 0.966, 0.947, 0.681, 0.673 | 0.947 / 9.644 |
| 5 | 0.626, 0.630, 3.113, 0.380, 0.399 | 0.626 / 3.113 | 0.829, 0.842, 3.403, 0.538, 0.528 | 0.829 / 3.403 |
| 10 | 0.585, 0.507, 0.476, 0.486, 0.508 | 0.507 / 0.585 | 0.754, 0.621, 0.599, 0.583, 0.622 | 0.621 / 0.754 |
| 30 | 0.922, 0.916, 1.081, 0.841, 0.853 | 0.916 / 1.081 | 1.035, 1.019, 1.266, 0.941, 0.942 | 1.019 / 1.266 |

The timings describe an instrumented in-memory run with no model traffic. Cloudflare storage I/O, Worker CPU time and production lock occupancy were not measured for this workload. The first one-turn sample includes cold setup.

## Recovery and decision

The restart fixture saves turn 1's omission, leaves turn 2 without a marker, and reopens the same backing store through a new session object. The successor reuses turn 1's marker, completes turn 2's omission, and submits with neither turn in its context. The dropped-connection cases cover a provider failure and an interruption and check the actual successor prompt. The restart fixture covers a missing marker at restart. A crash after the marker is recorded but before its write settles would need a controllable pause inside the persisted submission. [Engine fixtures](../apps/api/test/PiDurableEngine.test.ts)

Keep the admission path as it stands. The increasing call count is reproducible, but these timings do not establish a production impact. Revisit after measuring a representative Durable Object under repeated interrupted or unpublished turns. Any checkpoint should advance only over contiguous turns whose omission writes have settled. Missing markers, an out-of-order completion, and interruption before settlement must leave the range eligible for replay. Prove recovery after crashes on both sides of the marker write, then verify that publication advances the range and that a successor's prompt excludes abandoned entries. The current engine and its omission request IDs are the comparison for those checks.
