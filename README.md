<p align="left">
  <img src="apps/app/public/favicon.svg" width="44" height="44" alt="Checkfu" />
</p>

# Checkfu

**Open-source managed agents for any model. Runs in your own Cloudflare account.**

[![CI](https://github.com/checkfu/checkfu/actions/workflows/ci.yml/badge.svg)](https://github.com/checkfu/checkfu/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Built on Cloudflare Workers, Durable Objects, [Pi Durable](https://github.com/earendil-works), [Alchemy](https://alchemy.run), and [Effect](https://effect.website).

## Quickstart

Requires Node.js 22+, a Cloudflare account (Workers Paid, R2 enabled), and a model provider API key.

```sh
npm install -g checkfu
checkfu deploy
```

Signs in to Cloudflare, prompts for a provider key, deploys the server from `origin/main`, and saves credentials in `~/.config/checkfu` (re-run `checkfu deploy` to update in place; see the [CLI guide](apps/cli/README.md)).

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
# yaml-language-server: $schema=https://your-api.workers.dev/schemas/apply/automation.json
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
checkfu apply . --dry-run
checkfu apply . --yes
```

### TypeScript ([`@checkfu/sdk`](packages/sdk/README.md))

```ts
import Checkfu from "@checkfu/sdk"

const client = new Checkfu({
  baseUrl: "https://your-api.workers.dev",
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

## Architecture

- **Pi (`@earendil-works/pi-ai`, `pi-durable`, `pi-codemode`, [`@checkfu/pi-providers`](packages/pi-providers/README.md)):** Runs durable sessions in `PiSession` Durable Objects across Anthropic, OpenAI, OpenRouter, Cloudflare AI Gateway, Workers AI, and custom `CHECKFU_PROVIDERS`.
- **Alchemy (`alchemy`, `@alchemy.run/cloudflare`, `@alchemy.run/domain`):** Declares all Cloudflare resources in `alchemy.run.ts` (no `wrangler.toml`) and runs event-sourced aggregates, decisions, sagas, and views proved with **Z3**.
- **Effect & Forge (`effect`, `@cloudflare/forge`):** Defines routes, events, and errors once in `CheckfuApi` and generates `openapi.json`, `@checkfu/sdk`, the CLI, and the MCP server.
- **Cloudflare (`@cloudflare/computer`, Durable Objects, D1, R2):** Isolates per-session filesystems, Linux shells, credentials, and webhook delivery in Durable Objects, with D1 for lists and R2 for artifacts.

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
        ├── File, git, bash & save   ──► SessionWorkspace DO + on-demand Linux machine + artifact_data
        ├── codemode (JS scripts)    ──► CodemodeSandboxWorker (QuickJS, no network/timers, journaled)
        ├── MCP tools                ──► Connection DO (attaches vault bearer token; enforces approvals)
        └── Custom tools             ──► Pauses session (requires_action, $0 compute) until app posts result
```

## API & Clients

| Resource | Endpoint | Purpose |
| :--- | :--- | :--- |
| **Agent** | `/v1/agents` | Model, system prompt, MCP servers, custom tools, and approval rules; versioned on edit. |
| **Environment** | `/v1/environments` | Sandbox networking policy (`unrestricted`, or `limited` host/MCP/package allowlists). |
| **Session** | `/v1/sessions` | Conversation, `/workspace` filesystem, and shell bound to an agent, environment, and mounts. |
| **Memory store** | `/v1/memory_stores` | Cross-session UTF-8 files with SHA-256 preconditions, mounted at `/mnt/memory/<name>`. |
| **Artifact** | `/v1/artifacts` | Versioned R2 file sets and document collections, served via signed links or sandboxed sites. |
| **Vault** | `/v1/vaults` | Credential store isolating each MCP bearer secret in its own `Connection` Durable Object. |
| **Automation** | `/v1/automations` | Cron (with IANA timezone) or manual session triggers with pinned agent versions and run history. |
| **Webhook** | `/v1/webhooks` | HMAC-signed event subscriptions with Durable Object fan-out, retries, and delivery history. |

- **SDK ([`packages/sdk`](packages/sdk/README.md)):** `npm install @checkfu/sdk` for Effect (`CheckfuClient`) and Promise (`new Checkfu()`) clients (`GET /openapi.json` for other languages).
- **CLI ([`apps/cli`](apps/cli/README.md)):** `npm install -g checkfu` for `deploy`, `apply`, `sessions connect`, `--format`, and GJSON `--transform`.
- **Dashboard:** Sign in with `CHECKFU_API_KEY` to edit resources (Form or YAML), manage artifact grants, inspect webhooks, and stream transcripts.
- **MCP (`2026-07-28`):** Connect an HTTP MCP client to `https://<mcp-worker>.workers.dev/mcp` with `Authorization: Bearer $CHECKFU_API_KEY` (`{ versionNegotiation: { mode: "auto" } }` in `@modelcontextprotocol/client`).

## Development

Copy [`.env.example`](.env.example) to `.env`, set `CHECKFU_API_KEY` and a model provider key, then start the local runtime (`:1337` API, `:1338` MCP, `http://app-1340.localhost:1340` dashboard):

```sh
[ -f .env ] || cp .env.example .env
bun install
bun run dev
```

- `bun run generate`: Regenerate `openapi.json`, CLI, SDK, and MCP from `CheckfuApi`
- `bun run check` / `bun run typecheck`: Lint, format, directive, and full TypeScript checks
- `bun run test`: Unit tests (`CHECKFU_PROVE=1` includes the Z3 domain proofs run in CI)
- `bun run test:bun` / `bun run test:workerd`: Bun and `workerd` integration tests
- `bun run persisted:check`: Verify stored-data compatibility against committed baselines
- `bun run release:build`: Build and qualify `checkfu` and `@checkfu/sdk` release tarballs

### Layout

- [`apps/api`](apps/api): HTTP/SSE API, domain host, Pi harness, workspaces, connections, webhooks, content Worker
- [`apps/app`](apps/app): TanStack Router/Query web dashboard Worker
- [`apps/cli`](apps/cli): `checkfu` CLI
- [`apps/mcp`](apps/mcp): Generated HTTP MCP Worker
- [`packages/authoring`](packages/authoring): Markdown/YAML project parser, validator, and `checkfu-lock.json` codec
- [`packages/domain`](packages/domain): Event-sourced aggregates, decisions, policies, sagas, views, and Z3 proofs
- [`packages/pi-providers`](packages/pi-providers): Model catalog, custom provider manifests, and wire adapters
- [`packages/sdk`](packages/sdk): Effect and Promise SDKs, plus `CheckfuApi`
- [`packages/snapshots`](packages/snapshots): Versioned snapshot codecs
- [`packages/ui`](packages/ui): Dashboard UI components
- [`tools/forge`](tools/forge): OpenAPI, CLI, SDK, and MCP codegen
- [`tools/release`](tools/release): Release packaging and qualification

## License

[Apache 2.0](LICENSE)
