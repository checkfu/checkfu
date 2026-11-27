<p align="left">
  <img src="apps/app/public/favicon.svg" width="44" height="44" alt="Checkfu" />
</p>

# Checkfu

**Open-source managed agents for any model. Runs in your own Cloudflare account.**

[![CI](https://github.com/checkfu/checkfu/actions/workflows/ci.yml/badge.svg)](https://github.com/checkfu/checkfu/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Built on Cloudflare Workers, Durable Objects, [Pi Durable](https://github.com/earendil-works), [Alchemy](https://alchemy.run), and [Effect](https://effect.website), with one API across HTTP, TypeScript, CLI, MCP, and a web dashboard.

## npm clients

```sh
npm install -g checkfu
checkfu deploy
```

The npm CLI requires Node.js 22 or later. Install `@checkfu/sdk` for the JavaScript/TypeScript client. See the [CLI guide](apps/cli/README.md) and [SDK guide](packages/sdk/README.md).

## Quickstart

Requires Node.js 22+, a Cloudflare account (Workers Paid, R2 enabled), and a model provider API key.

### Deploy

```sh
npm install -g checkfu
checkfu deploy
```

Signs in to Cloudflare, prompts for a provider key, deploys the latest server and sandbox from `origin/main`, and saves the connection under `~/.config/checkfu`. Run `checkfu deploy` again to update the same deployment and keep its data. No source checkout or local Docker is required.

```sh
checkfu agents create --name Assistant --model your-model-id
checkfu environments create --name default
checkfu sessions create --agent <agent-id> --environment-id <environment-id>
checkfu sessions connect <session-id>
```

### Configuration as code

Define agents, environments, and automations as Markdown or YAML (or export them from the dashboard) and reconcile them with `checkfu-lock.json`:

```md
---
# agents/support.md
name: Support
model: your-model-id
---

Answer support questions and cite the source you used.
```

```yaml
# yaml-language-server: $schema=http://localhost:1337/schemas/apply/automation.json
# automations/report.yaml
name: Weekday report
agent: ../agents/support.md
environment_id: ../environments/cloud.yaml
initial_events:
  - type: user.message
    content: [{ type: text, text: Write the daily support report. }]
schedule: { type: cron, expression: "0 9 * * 1-5", timezone: America/New_York }
```

```sh
bun checkfu apply . --dry-run
bun checkfu apply . --yes
```

### Local dev

Set `CHECKFU_API_KEY` and your model provider credentials in `.env` (see [`.env.example`](.env.example)):

```sh
[ -f .env ] || cp .env.example .env
bun install
bun run dev
```

Starts the API (`http://localhost:1337`), MCP server (`http://localhost:1338`), and dashboard (`http://app-1340.localhost:1340`).

### TypeScript ([`packages/sdk`](packages/sdk/README.md))

```ts
import Checkfu from "@checkfu/sdk"

const client = new Checkfu({
  baseUrl: "http://localhost:1337",
  apiKey: process.env.CHECKFU_API_KEY,
})

const agent = await client.waitForPending(
  await client.agents.create({ name: "Assistant", model: "your-model-id" }),
)
const env = await client.waitForPending(await client.environments.create({ name: "default" }))
const session = await client.waitForPending(
  await client.sessions.create({
    agent: agent.id,
    environment_id: env.id,
    resources: [{ type: "github_repository", url: "https://github.com/acme/repo" }],
  }),
)

await client.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "Summarize recent commits." }] }],
})

for await (const event of await client.sessions.events.stream(session.id)) {
  if (event.type === "agent.message") console.log(event.content.map((b) => b.text).join(""))
  if (event.type === "session.status_idle") break
}
```

## Stack

- **Pi (`@earendil-works/pi-ai`, `pi-durable`, `pi-codemode`, [`@checkfu/pi-providers`](packages/pi-providers/README.md)):** Runs each session in a `PiSession` Durable Object with SQLite history, context compaction, journaled `codemode` calls, and $0-compute turn pauses on approvals or custom tools. Supports Anthropic, OpenAI, OpenRouter, Cloudflare AI Gateway, Workers AI, and custom `CHECKFU_PROVIDERS`.
- **Alchemy (`alchemy`, `@alchemy.run/cloudflare`, `@alchemy.run/domain`):** `alchemy.run.ts` declares Workers, Durable Objects, D1, R2, and domains in TypeScript with no `wrangler.toml`. `@alchemy.run/domain` runs event-sourced aggregates, cross-object decisions, sagas, and views on Durable Objects and proves invariants with **Z3**.
- **Effect & Forge (`effect`, `@cloudflare/forge`):** `CheckfuApi` defines routes, events, and errors once with Effect `HttpApi` and `Schema`; `tools/forge` generates `openapi.json`, `@checkfu/sdk`, the CLI, and the MCP server.
- **Cloudflare (`@cloudflare/computer`, Durable Objects, D1, R2):** `@cloudflare/computer` backs each session's `/workspace` filesystem and on-demand shell machine. Durable Objects isolate sessions, workspaces, credentials, and webhook delivery; D1 serves lists; R2 stores artifacts.

```text
  Clients (SDK / CLI / curl)      MCP Clients       Browser (Admin)       Browser (Viewers)
              │                        │                   │                      │
              ▼                        ▼                   ▼                      ▼
     ┌─────────────────┐      ┌─────────────────┐ ┌─────────────────┐    ┌─────────────────┐
     │    ApiWorker    │◄─────│    McpWorker    │ │       App       │    │  ContentWorker  │
     │ /v1/* + Domain  │      │   /mcp server   │ │    Dashboard    │    │  Signed links   │
     │ + Webhook DOs   │◄─────┴────────┬────────┘ │ (holds API key) │    │ & public sites  │
     └────────┬────────┘               │          └────────┬────────┘    └────┬───────┬────┘
              │  ▲                     └───────────────────┴──────────────────┘       │
      ┌───────┼──┴───────────────────────────┐                                        │
      ▼       ▼                              ▼                                        ▼
  ┌───────┐ ┌────┐              ┌─────────────────────────┐                      ┌────────┐
  │  D1   │ │ R2 │              │     PiHarnessWorker     │                      │   R2   │
  │ Lists │ │    │              │   (no public address)   │                      │ (read) │
  └───────┘ └────┘              │  • PiSession DO         │                      └────────┘
                                │  • SessionWorkspace DO  │
                                │  • SessionSandbox DO    │
                                │  • Connection DO / cred │
                                └────────────┬────────────┘
                                             │
                                             ▼
                                ┌─────────────────────────┐
                                │  CodemodeSandboxWorker  │
                                │   (no public address)   │
                                │  • QuickJS Sandbox DO   │
                                └─────────────────────────┘
```

### Layout

- [`apps/api`](apps/api): HTTP/SSE API, domain host, Pi harness, workspaces, connections, webhooks, content Worker
- [`apps/app`](apps/app): TanStack Router/Query web dashboard Worker
- [`apps/cli`](apps/cli): `checkfu` CLI (`deploy`, `apply`, `login`, `destroy`, `sessions connect`, resource commands)
- [`apps/mcp`](apps/mcp): Generated HTTP MCP Worker
- [`packages/authoring`](packages/authoring): Markdown/YAML project parser, validator, and `checkfu-lock.json` codec
- [`packages/domain`](packages/domain): Event-sourced aggregates, decisions, policies, sagas, views, and Z3 proofs
- [`packages/pi-providers`](packages/pi-providers): Model catalog, custom provider manifests, and wire adapters
- [`packages/sdk`](packages/sdk): Effect and Promise SDKs, plus `CheckfuApi`
- [`packages/snapshots`](packages/snapshots): Versioned snapshot codecs
- [`packages/ui`](packages/ui): Dashboard UI components
- [`tools/forge`](tools/forge): OpenAPI, CLI, SDK, and MCP codegen

## Capabilities

| Resource | Endpoint | Purpose |
| :--- | :--- | :--- |
| **Agent** | `/v1/agents` | Model, system prompt, MCP servers, custom tools, and approval rules; edits mint immutable versions. |
| **Environment** | `/v1/environments` | Sandbox networking policy (`unrestricted`, or `limited` host/MCP/package allowlists). |
| **Session** | `/v1/sessions` | Stateful conversation, `/workspace` filesystem, and shell bound to an agent, environment, and mounts. |
| **Memory store** | `/v1/memory_stores` | Cross-session UTF-8 files with SHA-256 preconditions, mounted at `/mnt/memory/<name>`. |
| **Artifact** | `/v1/artifacts` | Versioned R2 file sets; mountable in sessions, shareable via signed links, or published as sandboxed sites. |
| **Vault** | `/v1/vaults` | Credential store isolating each MCP bearer secret in its own `Connection` Durable Object. |
| **Automation** | `/v1/automations` | Cron (with IANA timezone) or manual session triggers with pinned agent versions and run history. |
| **Webhook** | `/v1/webhooks` | HMAC-signed event subscriptions with Durable Object fan-out, retries, and delivery history. |

```text
  Session (PiSession DO)
   ├── Filesystem (SessionWorkspace DO)
   │    ├── /workspace/<repo>        ◄── Cloned GitHub repos + scoped git fetch/pull/push
   │    ├── /mnt/memory/<store>      ◄── Live read/write or read-only MemoryStore passthrough
   │    ├── /mnt/artifacts/<name>    ◄── Version-pinned read-only R2 Artifact passthrough
   │    ├── /mnt/skills/<name>       ◄── Validated SKILL.md + resources (read-only)
   │    └── /mnt/session/outputs     ──► Saved as an Artifact version after each reply
   │
   └── Tool Execution
        ├── File, git & bash tools   ──► SessionWorkspace DO + on-demand SessionSandbox machine
        ├── codemode (JS scripts)    ──► CodemodeSandboxWorker (QuickJS, no network/timers, journaled)
        ├── MCP tools                ──► Connection DO (attaches vault bearer token; enforces approvals)
        └── Custom tools             ──► Pauses session (requires_action, $0 compute) until app posts result
```

## Interfaces

- **SDK ([`packages/sdk`](packages/sdk/README.md)):** Effect (`CheckfuClient`) and Promise (`new Checkfu()`) clients with retries, idempotency, SSE, and pagination (`GET /openapi.json` for other languages).
- **CLI (`checkfu`):** `bun checkfu --help` or standalone `bun run checkfu:build`, with `apply`, `--format`, and GJSON `--transform`.
- **Dashboard:** Sign in with `CHECKFU_API_KEY` to edit resources (Form or YAML), inspect webhook deliveries, and stream live transcripts.
- **MCP (`2026-07-28`):** Connect an HTTP MCP client to `https://<mcp-worker>.workers.dev/mcp` with `Authorization: Bearer $CHECKFU_API_KEY` (with `@modelcontextprotocol/client`, pass `{ versionNegotiation: { mode: "auto" } }`).

## Development

See [`docs/verification.md`](docs/verification.md) for the maintained acceptance journeys, Z3 proof gates, and storage compatibility locks.

- `bun run generate`: Regenerate `openapi.json`, CLI, SDK, and MCP from `CheckfuApi`
- `bun run check`: Check generated files, `oxfmt`, directives, and `oxlint` with type errors in one pass. `bun run typecheck` runs each package's own typecheck, as CI does
- `bun run test`: Run unit tests (`CHECKFU_PROVE=1` includes the Z3 domain proofs run in CI)
- `bun run test:bun` / `bun run test:workerd`: Bun and `workerd` integration tests
- `bun run checkfu:build`: Build standalone binary at `apps/cli/dist/checkfu`

## License

[Apache 2.0](LICENSE)
