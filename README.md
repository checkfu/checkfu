<p align="left">
  <img src="apps/app/public/favicon.svg" width="44" height="44" alt="Checkfu" />
</p>

# Checkfu

**Open-source managed agents for any model. Runs in your own Cloudflare account.**

[![CI](https://github.com/checkfu/checkfu/actions/workflows/ci.yml/badge.svg)](https://github.com/checkfu/checkfu/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Why Checkfu](#why-checkfu) · [Quickstart](#quickstart) · [Stack and Architecture](#stack-and-architecture) · [Capabilities](#capabilities) · [Interfaces](#interfaces) · [Operations](#operations)

Checkfu is a self-hosted managed agent runtime built on Cloudflare Workers, Durable Objects, [Pi Durable](https://github.com/earendil-works), [Alchemy](https://alchemy.run), and [Effect](https://effect.website). You define agents, environments, memory, vaults, and tools through one API, and run stateful sessions over HTTP, TypeScript, the CLI, MCP, or the web dashboard.

## Why Checkfu

Model vendors offer managed agent APIs, but each ties your sessions, files, memory, and credentials to one model family and a closed runtime. Self-hosted alternatives avoid model lock-in, but usually require running containers, Postgres, Redis, queues, and sandbox VMs. Checkfu runs the whole stack on Cloudflare primitives in your own account.

- **Multi-model on Pi.** Built on Pi's provider layer (`@earendil-works/pi-ai`). Anthropic (`claude-*`) and OpenAI (`gpt-*`, `o*`) are wired in today, with the rest of Pi's catalog (including OpenRouter) following.
- **No servers to run.** `bun checkfu deploy` deploys everything to your Cloudflare account on Workers, Durable Objects, D1, and R2. Idle sessions and paused turns hibernate in Durable Objects and cost $0 in compute while waiting.
- **Hard boundaries for secrets and code.** Model provider keys live only in a private harness Worker with no public URL. Each vault credential lives in its own Durable Object and never enters prompts, logs, or views. Agent scripts run in an isolated QuickJS Worker, and HTML artifacts serve from a sandboxed origin.
- **Verified domain and single-source API.** Domain aggregates, cross-object decisions, and views are proved with **Z3** in CI. One Effect `HttpApi` definition generates `openapi.json`, the TypeScript SDK, the CLI, and the MCP server.

| | Model-vendor agent APIs | Container agent stacks | Checkfu |
| :--- | :--- | :--- | :--- |
| **License** | Proprietary | Open or source-available | **Apache 2.0** |
| **Models** | Single vendor | Multi-model | **Multi-model on Pi** (Anthropic & OpenAI today; OpenRouter next) |
| **Deployment** | Vendor cloud | Containers, Postgres, Redis, VMs | **One command to your Cloudflare account** |
| **Idle & paused turns** | Metered session / sandbox hours | Always-on servers | **$0 compute** (hibernated Durable Objects) |
| **Secret storage** | Vendor vault | Shared database | **One Durable Object per credential** |
| **State correctness** | Closed | Unit tests | **Z3-proved domain invariants** |

## Quickstart

You need [Bun](https://bun.sh) 1.4+, Node.js 22.18+, 24, or 26+, a Cloudflare account with R2 enabled, and an Anthropic or OpenAI API key. Use the Workers Paid plan; the free plan limits CPU to 10 ms per request, which an agent turn can exceed.

### Deploy to Cloudflare

```sh
git clone https://github.com/checkfu/checkfu && cd checkfu
bun install
bun checkfu deploy
```

On first run, `deploy` signs in to Cloudflare in your browser, prompts for a model provider key if none is set, shows the plan, and deploys six Workers. It writes `CHECKFU_API_KEY` to `.env`, records the deployment in `.checkfu/deployment.json`, waits for `/health`, and saves the URL and key to `~/.config/checkfu/config.json` (owner-only on macOS and Linux).

Then create an agent, an environment, and a session, and open an interactive prompt (`gpt-6.2-sol` if you used an OpenAI key):

```sh
bun checkfu agents create --name Assistant --model claude-sonnet-5-5
bun checkfu environments create --name default
bun checkfu sessions create --agent-id <agent-id> --environment-id <environment-id>
bun checkfu sessions connect <session-id>
```

### Run locally without Cloudflare

Copy `.env.example` to `.env`, set `CHECKFU_API_KEY` plus `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and start Alchemy's local runtime:

```sh
[ -f .env ] || cp .env.example .env
bun install
bun run dev
```

`bun run dev` prints local URLs for the API (`http://localhost:1337`), MCP server (`http://localhost:1338`), and dashboard (`http://app-1340.localhost:1340`).

### Call from TypeScript

Inside the workspace (see [`packages/sdk`](packages/sdk/README.md)):

```ts
import Checkfu from "@checkfu/sdk"

const client = new Checkfu({
  baseUrl: "http://localhost:1337", // or your deployed workers.dev URL
  apiKey: process.env.CHECKFU_API_KEY,
})

// waitForPending returns 201 responses directly, or polls when a view answers 202
const agent = await client.waitForPending(
  await client.agents.create({ name: "Assistant", model: "claude-sonnet-5-5" }),
)
const env = await client.waitForPending(await client.environments.create({ name: "default" }))
const session = await client.waitForPending(
  await client.sessions.create({ agent: agent.id, environment_id: env.id }),
)

await client.sessions.events.send(session.id, {
  events: [
    {
      type: "user.message",
      content: [{ type: "text", text: "Write a URL router to /workspace/router.ts and test edge cases." }],
    },
  ],
})

for await (const event of await client.sessions.events.stream(session.id)) {
  if (event.type === "agent.message") {
    console.log(event.content.map((b) => b.text).join(""))
  }
  if (event.type === "session.status_idle") break
}
```

## Stack and Architecture

Checkfu is built out of four main layers:

- **Pi and Pi Durable (`@earendil-works/pi-ai`, `pi-durable`, `pi-codemode`).** `pi-ai` normalizes model calls, streaming, usage accounting, and provider refusals. `pi-durable` runs the conversation loop inside a `PiSession` Durable Object: it stores conversation entries in SQLite, compacts context windows, recovers interrupted turns on restart, journals `codemode` tool calls so restarts do not repeat finished work, and parks turns when a tool needs human approval or client execution.
- **Alchemy (`alchemy`, `@alchemy.run/cloudflare`, `@alchemy.run/domain`).** `alchemy.run.ts` declares all Workers, Durable Object bindings, D1 databases, R2 buckets, DNS records, custom domains, and production removal guards as typed Effect programs (no `wrangler.toml` files or Terraform). `@alchemy.run/domain` hosts event-sourced aggregates, two-phase cross-object decisions, sagas, policies, and views on Durable Objects, and checks their invariants with **Z3** (`@alchemy.run/domain/Verify`).
- **Effect and Forge (`effect`, `@cloudflare/forge`).** `CheckfuApi` (`effect/http-api/HttpApi`) and Effect `Schema` define every route, event, and error once. `tools/forge` generates `openapi.json`, `@checkfu/sdk`, the `checkfu` CLI, and the MCP server from that contract.
- **Cloudflare storage (`@cloudflare/computer`, Durable Objects, D1, R2).** `@cloudflare/computer` backs each session's `/workspace` SQLite filesystem. Durable Objects hold domain streams, sessions, workspaces, and per-credential `Connection` objects; D1 backs cursor-paginated resource lists; R2 stores content-addressed artifact blobs.

```text
  Clients (SDK / CLI / curl)      MCP Clients       Browser (Admin)       Browser (Viewers)
              │                        │                   │                      │
              ▼                        ▼                   ▼                      ▼
     ┌─────────────────┐      ┌─────────────────┐ ┌─────────────────┐    ┌─────────────────┐
     │    ApiWorker    │◄─────│    McpWorker    │ │       App       │    │  ContentWorker  │
     │ /v1/* + Domain  │      │   /mcp server   │ │    Dashboard    │    │ Sandboxed links │
     │ Durable Objects │◄─────┴────────┬────────┘ │ (holds API key) │    │ & public sites  │
     └────────┬────────┘               │          └────────┬────────┘    └────┬───────┬────┘
              │  ▲                     └───────────────────┴──────────────────┘       │
      ┌───────┼──┴───────────────────────────┐                                        │
      ▼       ▼                              ▼                                        ▼
  ┌───────┐ ┌────┐              ┌─────────────────────────┐                      ┌────────┐
  │  D1   │ │ R2 │              │     PiHarnessWorker     │                      │   R2   │
  │ Lists │ │    │              │   (no public address)   │                      │ (read) │
  └───────┘ └────┘              │  • PiSession DO         │                      └────────┘
                                │  • SessionWorkspace DO  │
                                │  • Connection DO / cred │
                                │  • ApiCatalog DO        │
                                └────────────┬────────────┘
                                             │
                                             ▼
                                ┌─────────────────────────┐
                                │  CodemodeSandboxWorker  │
                                │   (no public address)   │
                                │  • QuickJS Sandbox DO   │
                                └─────────────────────────┘
```

| Worker | Public URL | Secrets held | Role |
| :--- | :--- | :--- | :--- |
| **`ApiWorker`** | Yes | `CHECKFU_API_KEY`, link signing key | HTTP/SSE routes, event-sourced domain Durable Objects, D1 listings, R2 artifact writes |
| **`PiHarnessWorker`** | **No** | Model provider keys, per-credential `Connection` secrets | `PiSession` turns, `/workspace` filesystems, `git`, outbound MCP/OpenAPI requests, OpenAPI catalogs |
| **`CodemodeSandboxWorker`** | **No** | None | Runs agent `codemode` JavaScript scripts in isolated QuickJS Durable Objects |
| **`ContentWorker`** | Yes | Link signing key | Serves expiring artifact links and public sites with `Content-Security-Policy: sandbox` and read-only R2 |
| **`McpWorker`** | Yes | None (forwards caller key) | Exposes `CheckfuApi` operations as HTTP MCP tools (`2026-07-28`) over a service binding |
| **`App`** | Yes | `CHECKFU_API_KEY` | Web dashboard; trades the API key for a signed 7-day HttpOnly session cookie |

### Repository Layout

- [`apps/api`](apps/api): HTTP handlers, domain wiring, Pi harness, workspaces, connections, OpenAPI importer, content Worker
- [`apps/app`](apps/app): Vite + TanStack Router/Query web dashboard Worker
- [`apps/cli`](apps/cli): Effect CLI (`deploy`, `login`, `destroy`, `sessions connect`, generated resource commands)
- [`apps/mcp`](apps/mcp): Generated HTTP MCP Worker
- [`packages/domain`](packages/domain): Aggregates, decisions, policies, sagas, views, and Z3 verification suites
- [`packages/sdk`](packages/sdk): `@checkfu/sdk` Effect and Promise clients, plus the shared `CheckfuApi` contract
- [`packages/snapshots`](packages/snapshots): Versioned snapshot codecs
- [`packages/ui`](packages/ui): Dashboard UI components
- [`tools/forge`](tools/forge): `@cloudflare/forge` generator for OpenAPI, CLI, SDK, and MCP

## Capabilities

| Resource | Endpoint | Purpose |
| :--- | :--- | :--- |
| **Agent** | `/v1/agents` | Model, system prompt, MCP & OpenAPI servers, custom tools, and approval policies. Edits mint immutable versions (`1`, `2`, ...). |
| **Environment** | `/v1/environments` | Network policy (`unrestricted`, or `limited` with `allowed_hosts`, `allow_mcp_servers`, `allow_package_managers`). |
| **Session** | `/v1/sessions` | Stateful conversation and `/workspace` filesystem bound to an agent (pinned or latest), environment, mounts, and credentials. |
| **Memory store** | `/v1/memory_stores` | Cross-session UTF-8 files with SHA-256 preconditions, mounted live at `/mnt/memory/<name>`. |
| **Artifact** | `/v1/artifacts` | Versioned file sets in R2; can be mounted into sessions, opened via expiring links, or published as sites. |
| **Vault** | `/v1/vaults` | Credential store (`static_bearer`, `mcp_oauth`, `api_key`) with one Durable Object per secret. |
| **Automation** | `/v1/automations` | Cron (with IANA timezone) or manual trigger that opens sessions and records per-run history. |

### Inside a Session

```text
  Session (PiSession DO)
   ├── Filesystem (SessionWorkspace DO)
   │    ├── /workspace/<repo>        ◄── Cloned GitHub repos + scoped git fetch/pull/push
   │    ├── /mnt/memory/<store>      ◄── Live read/write or read-only MemoryStore passthrough
   │    ├── /mnt/artifacts/<name>    ◄── Version-pinned read-only R2 Artifact passthrough
   │    ├── /mnt/skills/<name>       ◄── Validated SKILL.md + resources (read-only)
   │    └── /mnt/session/outputs     ──► Auto-published as a new Artifact version after each reply
   │
   └── Tool Execution
        ├── File & git tools         ──► SessionWorkspace DO (read, ls, find, grep, write, edit, delete, git)
        ├── codemode (JS scripts)    ──► CodemodeSandboxWorker (QuickJS, 32 MiB, no network/timers, journaled)
        ├── MCP & OpenAPI tools      ──► Connection DO (attaches bearer / OAuth / API key; gates approvals)
        └── Custom tools             ──► Pauses session (requires_action, $0 compute) until app posts result
```

- **Event log and streaming.** User messages, model replies, interrupts, and committed tool calls (`agent.tool_use`, `agent.mcp_tool_use`, `agent.api_tool_use`, `agent.custom_tool_use` and their results) append to the session log and push directly to `/v1/sessions/{id}/events/stream`. Failed or interrupted turns drop uncommitted tool rounds so conversation history matches the log.
- **GitHub mounts (`github_repository`).** Mount up to 8 repos at session creation (branch head or commit SHA). Public repos need no token; private tokens stay inside the workspace object, can be rotated via `POST /v1/sessions/{id}/resources/{resource_id}`, and are erased when the session ends.
- **Memory, files, skills, and outputs.** A store holds up to 1,000 UTF-8 memories (100 kB each). Sessions mount up to 8 memory stores, 8 read-only artifacts, and 16 [Agent Skills](https://agentskills.io) (`SKILL.md`) without copying files. Anything written to `/mnt/session/outputs` is published at turn end to `GET /v1/sessions/{id}/outputs` (up to 64 files, 1 MiB per file, 4 MiB total).
- **Artifacts, links, and sites.** Upload UTF-8 or `"encoding": "base64"` files to `/v1/artifacts`; each new version replaces the whole set and older versions stay readable. A version holds up to 64 files (1 MiB each, 4 MiB total), and an upload body may be at most 12,828,672 bytes, so send escape-heavy content as base64. `GET /v1/artifacts` lists artifacts in creation order with their latest files; deleted artifacts never appear. Create HMAC-signed browser preview links (`POST .../versions/{version}/links`, 60 s to 7 d) or publish an artifact at a 128-bit public URL (`POST .../publication`, pinned to a version or tracking `latest`). Set `CHECKFU_PUBLISH_DOMAIN` to serve each published artifact on its own subdomain (`https://<id>.<publish-domain>/`).
- **MCP, OpenAPI, and Code Mode.** Agents attach remote HTTP MCP servers (`mcp_servers`) and up to 4 inline OpenAPI 3.0/3.1 JSON specs (`api_servers`, up to 256 operations filtered by `include` / `exclude`). With `codemode`, the agent can chain multiple tool calls (`await tools.read(...)`, `await tools.api__shop__getOrder(...)`) in a single turn inside QuickJS instead of burning one model round trip per call.
- **Approvals and custom tools.** Read-only MCP tools (`readOnlyHint`) and `GET` / `HEAD` / `OPTIONS` API operations run by default; other calls pause the session (`stop_reason: { "type": "requires_action" }`) until confirmed or denied with `user.tool_confirmation` (`always_allow` and `always_ask` are configurable per server and per tool; scripts cannot bypass `ask` gates). Custom tools (`type: "custom"`, up to 64 per agent) pause the same way until your app sends `user.custom_tool_result`.
- **Vaults and OAuth refresh.** Vaults hold up to 20 active credentials: `static_bearer` tokens, `mcp_oauth` grants (refreshed before expiry inside the `Connection` DO with single-flight deduplication and fail-closed `refresh_failed_at` state), and origin-locked `api_key` credentials (header or query, scrubbed from echoed responses). Rotating a secret applies on the next call; archiving revokes it immediately.
- **Automations.** Schedule agents with cron expressions and IANA timezones, or trigger runs manually (`POST /v1/automations/{id}/run`). Automations can pin an agent version or track `latest`, support partial updates, pause themselves with a recorded reason if their agent or environment is archived, and log the exact agent version used on every run.

## Interfaces

- **TypeScript SDK (`@checkfu/sdk`).** Workspace package at [`packages/sdk`](packages/sdk/README.md) providing both an Effect client (`CheckfuClient` + `Layer` + `Stream` + `Data.TaggedError`) and a Promise / `AsyncIterable` client (`new Checkfu()`), with retries, auto `Idempotency-Key` headers, SSE streaming, and cursor pagination. External apps in any language can also call `/v1/*` or generate clients from `GET /openapi.json`.
- **Web Dashboard.** Printed by `deploy` as `Dashboard` (`http://app-1340.localhost:1340` locally). Sign in with `CHECKFU_API_KEY` to manage sessions, agents, environments, and automations, and stream active transcripts.
- **CLI (`checkfu`).** Run `bun checkfu --help` in a trusted checkout, or compile a standalone binary with `bun run checkfu:build` (`apps/cli/dist/checkfu`). Supports `--format` (`auto`, `json`, `jsonl`, `yaml`, `pretty`, `raw`) and GJSON `--transform` queries across `agents`, `environments`, `sessions`, `sessions:events`, `sessions:resources`, `sessions:outputs`, `memory-stores`, `memory-stores:memories`, `artifacts`, `artifacts:versions`, `vaults`, `vaults:credentials`, `automations`, and `automations:runs`.
- **MCP Server.** `McpWorker` speaks MCP `2026-07-28` and exposes one tool per API operation, omitting credential create/update (`x-checkfu-mcp: false`) so secrets never pass through a calling model's context:

```sh
claude mcp add --transport http checkfu "https://<your-mcp-worker>.workers.dev/mcp" \
  --header "Authorization: Bearer $CHECKFU_API_KEY"
```

*(If you register a local `http://localhost:1338/mcp` server during `bun run dev`, run `claude mcp remove checkfu` when stopping the dev server so your client does not send the saved key to another process on that port later.)*

<details>
<summary><strong>Quickstart with <code>curl</code> and <code>jq</code></strong></summary>

`GET /health` and `GET /openapi.json` are public. `/v1/*` routes accept `Authorization: Bearer <key>` or `x-api-key: <key>`, and `GET /v1/auth/verify` checks a key without reading stored data.

```sh
(
  set -euo pipefail
  CHECKFU_URL="http://localhost:1337"
  CHECKFU_API_KEY="<same key from .env>"
  CHECKFU_MODEL="claude-sonnet-5-5" # or gpt-6.2-sol

  AGENT_ID=$(curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/agents" \
    -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg model "$CHECKFU_MODEL" '{name:"Assistant",model:$model,system:"You are concise and helpful."}')" \
    | jq -er '.id // error(tojson)')

  ENV_ID=$(curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/environments" \
    -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
    -d '{"name":"default"}' \
    | jq -er '.id // error(tojson)')

  SESSION_ID=$(curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/sessions" \
    -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg agent "$AGENT_ID" --arg env "$ENV_ID" '{agent:$agent,environment_id:$env}')" \
    | jq -er '.id // error(tojson)')

  curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/sessions/$SESSION_ID/events" \
    -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
    -H "Idempotency-Key: msg-1" \
    -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Hello Checkfu!"}]}]}' | jq .

  curl -N --fail-with-body "$CHECKFU_URL/v1/sessions/$SESSION_ID/events/stream" \
    -H "Authorization: Bearer $CHECKFU_API_KEY"
)
```

</details>

## Operations

### Development Scripts

- `bun run generate`: Regenerate `openapi.json` and Forge-derived CLI, SDK, and MCP code from `CheckfuApi`.
- `bun run check`: Verify generated artifacts, formatting (`oxfmt`), type-aware lint (`oxlint`), and TypeScript (`effect-tsgo`).
- `bun run test`: Run unit tests and Z3 domain proofs (`--filter=@checkfu/domain` runs the Z3 proofs alone).
- `bun run test:bun` and `bun run test:workerd`: Run Bun and Cloudflare `workerd` integration tests.
- `bun run checkfu:build`: Compile the standalone CLI binary at `apps/cli/dist/checkfu`.

### Deployment Management

- **Upgrade:** `git pull && bun install && bun checkfu deploy`. Reuses `.checkfu/deployment.json` and `.env`, previews the diff, and stops if your Cloudflare credentials point at a different account than the recorded deployment.
- **Log in from another machine:** `bun checkfu --base-url https://<your-api-worker>.workers.dev login`.
- **Deploy from CI:** Export `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, a model provider key, and a persistent `CHECKFU_API_KEY` (from your first deploy, or `openssl rand -hex 32`), then run `bun checkfu deploy --yes`. Without a TTY, `deploy` refuses to invent `CHECKFU_API_KEY` so CI runners never rotate it accidentally. `bun run deploy` runs raw `alchemy deploy` without secret setup, health checks, or saved CLI config.
- **Destroy:** `bun checkfu destroy --stage live` deletes all Workers and their data for a stage recorded by this checkout in the matching Cloudflare account (`bun run destroy --stage <name>` for raw Alchemy stages).

<details>
<summary><strong>Custom domains and publish domains</strong></summary>

- **API and MCP domains (`CHECKFU_API_DOMAIN`, `CHECKFU_MCP_DOMAIN`):** Set distinct hostnames in `.env` whose zones live in your target Cloudflare account, then run `bun checkfu deploy`. The `workers.dev` addresses keep working alongside them.
  - Setting a hostname replaces all custom hostnames on that Worker. Leaving it empty (and unset in your shell) keeps existing custom hostnames in place; set `none` and deploy to detach them.
  - **Rotate a hostname in two steps:** deploy with `none` first, then deploy with the new hostname. A one-step change detaches the old hostname before attaching the new one, so an invalid target leaves the Worker with neither.
- **Publish domain (`CHECKFU_PUBLISH_DOMAIN`):** Use a separate zone apex in your Cloudflare account (for example `example-pages.com` next to `example.com`) so published artifacts never share a registrable domain with your API. `deploy` adds a wildcard route and proxied `*` DNS record so publications serve from `https://<id>.<publish-domain>/`. While set, `CHECKFU_API_DOMAIN` and `CHECKFU_MCP_DOMAIN` must each be an explicit hostname outside that domain or `none` (not empty). `bun run dev` creates no wildcard route and serves publications under `/p/<id>/`.

</details>

<details>
<summary><strong>Data residency (<code>CHECKFU_JURISDICTION</code>, <code>CHECKFU_LOCATION_HINT</code>)</strong></summary>

Set `CHECKFU_JURISDICTION` (`eu`, `us`, or `fedramp`) before your first deploy:

- Durable Objects inside a jurisdiction are separate from objects of the same name outside it, and R2 and D1 are placed in the same jurisdiction (`fedramp-high` is refused because D1 and R2 do not support it).
- Changing `CHECKFU_JURISDICTION` later starts Durable Objects from empty and replaces the R2 bucket. Production refuses the change; on a personal stage with artifacts, run `bun checkfu destroy --stage <name>` before redeploying with a new value.
- `CHECKFU_LOCATION_HINT` (`wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`, `afr`, `me`) applies to newly created Durable Objects. D1 ignores the hint and places near the machine running the first deploy.

</details>

<details>
<summary><strong>CLI environment isolation and signals</strong></summary>

- `bun checkfu` starts Bun with `--no-env-file` and `apps/cli/bunfig.toml` so `.env` files and preloads in the working directory are never read into the CLI unless exported in your shell. Saved keys in `~/.config/checkfu/config.json` are sent only to the URL they were saved with.
- `bun checkfu` runs behind Bun's script runner: on macOS/Linux, `SIGKILL` requires killing the process group, and `Ctrl-C` in `sessions connect` is forwarded twice (interrupting the turn and disconnecting at once); on Windows, stopping the runner can leave the CLI running. For supervisors, Windows, or running outside a trusted checkout, invoke the compiled binary by its full path (`apps/cli/dist/checkfu`), which is a single process, asks before disconnecting on `Ctrl-C`, and ignores `.env` and `bunfig.toml` in its working directory.

</details>

<details>
<summary><strong>Production deploys, schema locks, and Durable Object protection</strong></summary>

```sh
bun run persisted:cut
git add apps/api/test/persisted/Persisted.lock.json && git commit -m "chore: cut persisted baseline"
bun run deploy:production
```

- **Persisted baseline lock:** Until `Persisted.lock.json` is cut and committed, personal stages may change stored shapes without migrations. Every `alchemy` command with `--stage production` (`deploy`, `logs`, `drift`, `destroy`) refuses to build until that baseline is committed, and later removals require migrations.
- **Resource protection (`RemovalPolicy.protect()`):** Once one `bun run deploy:production` completes, any plan that would delete or replace a production resource fails before applying changes.
- **Check plans for `unbind`:** Durable Object data lives in Durable Object classes, which resource protection does not cover. Dropping the last binding for a class, or renaming both a class and its binding without `renamedFrom`, deletes the class and every object in it and shows in the plan only as an `unbind`. Always inspect production plans for `unbind` lines. To destroy production intentionally, deploy once without `protectInProduction` in `alchemy.run.ts`, then run destroy.

</details>

## License

[Apache 2.0](LICENSE)
