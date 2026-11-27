# User contracts and refactor verification

A refactor should preserve observable behavior across interfaces, including what happens when a request fails or two users act at once. Passing a tool catalog or receiving HTTP200 is not sufficient. The checks below exercise persisted outcomes and refusal paths through the interfaces a user actually uses.

## Maintained acceptance journeys

These run in the existing CI jobs; they do not require provider credentials or a deployed Cloudflare account.

| Contract | Verification |
| --- | --- |
| Author a project, preview it without writes, apply dependencies and pin the applied agent version | `apps/api/test/workerd/UserJourneys.ts`, invoked by `PiSession.workerd.ts`: real Markdown/YAML files, compiled CLI, HTTP Workers and an independent MCP SDK client |
| Run the authored automation and retrieve its exact report bytes | Same journey: actual Durable Objects, provider HTTP protocol, workspace tool, output publication and artifact retrieval |
| Preserve old runs and agent history after applying edits | Same journey: future automation pin advances; previous session and v1 configuration remain unchanged |
| Block remote drift and require explicit intent before overwriting it | Same journey: a separate MCP editor changes the resource, apply refuses, and only `--force` reconciles it |
| Serialize competing CLI and MCP edits | Same journey: both use the same version, exactly one succeeds, the loser receives a conflict, and one version is created |
| Prune an authored project safely | Same journey: dependent automation is archived before its agent/environment, while previously produced output stays readable |
| Recover an uncertain MCP create without duplicating it | `apps/mcp/test/Mcp.interoperability.test.ts`: the official client negotiates the protocol, loses the reply after commit, then retries from another client; a changed request with the same key is refused |
| Preserve a browser user's draft without overwriting a teammate | `apps/app/test/user-journey.test.tsx`: actual router, forms, signed-cookie Worker boundary and domain backend; a separate SDK client makes the competing write |
| Preserve tools and historical configuration through YAML/Form editing and explicit rebase | Same UI journey: rejected YAML creates nothing, a stale edit is refused, and an explicit rebase preserves the teammate's unrelated edit and v1 history |
| Correct an invalid skill without partial session admission | Same UI journey: the real skill reader refuses the input artifact, no session is persisted, and the retained form creates the corrected session with pinned memory, artifact and skill mounts |
| Recover queued work after provider failure | `PiSession.workerd.ts`: controlled429,503 and truncated streams; the queued follow-up survives, one error is persisted, and one final reply is committed |
| Isolate pending actions between simultaneous sessions | `PiSession.workerd.ts`: three sessions wait on custom tools, foreign answers are refused, one session is archived, legitimate answers resume only their own session, and late/repeated answers are refused |

The DOM journeys use production routing and HTTP/domain code. The DOM and network adapter replace the browser platform; endpoint responses are not canned fixtures. They complement the existing component/error-state tests and an interactive browser pass. They do not establish CSS rendering or real-browser engine compatibility.

The workerd journeys use Alchemy's local deployment, actual Workers/Durable Objects and Docker where a machine is needed. The model provider is a controlled HTTP service so failures and scheduling can be reproduced without paid inference. Existing cases also exercise machine replacement and sleep/wake, artifact and memory persistence, repository clone/push, networking restrictions, credentials, MCP tool confirmation, interruption, SSE cursors and webhook delivery persistence.

## Domain guarantees

Aggregate and cross-aggregate transition rules state the invariants independently of the UI and transport. Examples include configuration stability within an agent version, immutable historical versions, guarded archive preconditions, and tool answers belonging to the exact requested session, call and turn.

`ToolActions.verify.test.ts` requires proved decision rules for confirmations and custom results. As in the unified model proof, the JSON set encoding helpers are opaque; the session/call identity comparisons remain symbolic. The full model's standing and source locks must also pass.

Shared decisions appear in both the `Checkfu` and `Sessions` verifiers. When their rules change, run both model verifiers, regenerate both source locks, and align both standing declarations with the required evidence. Updating only the unified model leaves the Sessions proof and replay gates incomplete.

`apps/api/test/persisted/Persisted.lock.json` records sample JSON and schema fingerprints for persisted shapes. CI and production deployment run `bun run persisted:check` against the committed baseline.

Before the first deployment whose data will be kept, keep one baseline. If a storage change makes the earlier samples unreadable, run `bun run persisted:cut --replace <label>` and commit the new baseline with the change.

Once a deployment's data will be kept, remove `--replace` and append baselines with `bun run persisted:cut`. Current readers must accept every recorded sample. Changed fingerprints require review, and incompatible changes need a working migration.

Z3 transition proofs, bounded exploration, replay and runtime tests provide different evidence. Keep their distinctions explicit. A successful bounded check must not be relabelled an unbounded proof. Do not relax requirements, exploration budgets, standing locks or assertions to make a refactor pass.

## Running the gate

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run persisted:check
bun x turbo run test --continue --concurrency=1 --filter='!@checkfu/domain'
bun run test:bun
bun run test:workerd
```

The domain CI jobs run with `CHECKFU_PROVE=1`, separating the unified proof from the other domain suites. `Sessions.verify` and `Sessions.replay.verify` each run on a runner of their own and share a 20-minute test deadline (`SESSIONS_PROOF_DEADLINE_MS`). `AutomationRuns.verify` also has its own runner and a 20-minute test deadline. A fixture creates an environment and agent and admits an automation with a valid cron expression through the production handlers. The search exhausts sequences of up to four caller commands and samples longer sequences. It checks successful and failed run reporting and slot reclamation. Each shard job has a 25-minute limit, including setup. The other domain files run in parallel on one more runner. The required `domain` check passes only when all shards pass. Investigate what grew when a proof approaches its deadline and record the reason for any increase.

Main's active CI run finishes while newer pushes replace the pending run. This lets the proof jobs complete and save their content-based task results even when main advances frequently. The next run reuses results only for unchanged inputs. PR updates cancel their older run.

On a local machine, run the heavy proof groups separately to avoid solver contention:

```sh
CHECKFU_PROVE=1 bun run --cwd packages/domain test --exclude test/Checkfu.verify.test.ts --exclude test/Sessions.verify.test.ts --exclude test/Sessions.replay.verify.test.ts --exclude test/AutomationRuns.verify.test.ts
CHECKFU_PROVE=1 bun run --cwd packages/domain test test/Sessions.verify.test.ts
CHECKFU_PROVE=1 bun run --cwd packages/domain test test/Sessions.replay.verify.test.ts
CHECKFU_PROVE=1 bun run --cwd packages/domain test test/AutomationRuns.verify.test.ts
CHECKFU_PROVE=1 bun run --cwd packages/domain test test/Checkfu.verify.test.ts
```

To work on a specific acceptance contract:

```sh
bun run --cwd apps/app test test/user-journey.test.tsx
bun run --cwd apps/mcp test test/Mcp.interoperability.test.ts
bun run --cwd apps/api test:workerd -t 'takes a YAML project|preserves a queued follow-up|isolates pending custom tools'
CHECKFU_PROVE=1 bun run --cwd packages/domain test test/ToolActions.verify.test.ts
```

Run a bounded staging smoke when changing provider integration, deployment infrastructure or browser behavior: use the supported MCP protocol, create a project, drive an actual provider turn across interfaces, verify canonical events and generated bytes, and inspect the UI in the intended browser profile. Use short prompts, bounded polling, an idle timeout and disposable resources. Archive schedules and clean up the deployment and owned registry image afterward.

A routine internal refactor should rely on these maintained contracts rather than a repeated manual tour. Add a regression at the highest useful boundary for each newly discovered issue, and strengthen the domain specification when an invariant is missing. Challenge important new gates with a deliberate temporary regression; restore the source before committing or deploying.
