<p align="left">
  <img src="apps/app/public/favicon.svg" width="44" height="44" alt="Checkfu" />
</p>

# Checkfu

**Open-source managed agents for any model. Runs in your own Cloudflare account.**

[![CI](https://github.com/checkfu/checkfu/actions/workflows/ci.yml/badge.svg)](https://github.com/checkfu/checkfu/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Built on Cloudflare Workers, Durable Objects, [Pi Durable](https://github.com/earendil-works), [Alchemy](https://alchemy.run), and [Effect](https://effect.website), with one API across HTTP, TypeScript, CLI, MCP, and a web dashboard.

## Quickstart

Requires [Bun](https://bun.sh) 1.4+, Node.js 22.18+, a Cloudflare account (Workers Paid, R2 enabled), and a model provider API key.

### Deploy

```sh
git clone https://github.com/checkfu/checkfu && cd checkfu
bun install
bun checkfu deploy
```

Signs in to Cloudflare, prompts for a provider key, deploys the stack, and writes `CHECKFU_API_KEY` to `.env` and `~/.config/checkfu/config.json`.

```sh
bun checkfu agents create --name Assistant --model claude-sonnet-5-5 # or gpt-6.2-sol
bun checkfu environments create --name default
bun checkfu sessions create --agent <agent-id> --environment-id <environment-id>
bun checkfu sessions connect <session-id>
```

Send a message in `sessions connect` to start work and follow the session's events live.

### Local dev

Set `CHECKFU_API_KEY` and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`:

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
  await client.agents.create({ name: "Assistant", model: "claude-sonnet-5-5" }),
)
const env = await client.waitForPending(await client.environments.create({ name: "default" }))
const session = await client.waitForPending(
  await client.sessions.create({ agent: agent.id, environment_id: env.id }),
)

await client.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "Write /workspace/router.ts." }] }],
})

for await (const event of await client.sessions.events.stream(session.id)) {
  if (event.type === "agent.message") console.log(event.content.map((b) => b.text).join(""))
  if (event.type === "session.status_idle") break
}
```

## Stack

- **Pi (`@earendil-works/pi-ai`, `pi-durable`, `pi-codemode`, `@checkfu/pi-providers`)** runs each session in a `PiSession` Durable Object with SQLite history, context compaction, and journaled `codemode` calls. Use [`@checkfu/pi-providers`](packages/pi-providers/README.md) to configure model providers.
- **Alchemy (`alchemy`, `@alchemy.run/cloudflare`, `@alchemy.run/domain`):** `alchemy.run.ts` declares Workers, Durable Objects, D1, R2, and domains in TypeScript with no `wrangler.toml`. `@alchemy.run/domain` runs event-sourced aggregates, cross-object decisions, sagas, and views on Durable Objects and proves invariants with **Z3**.
- **Effect & Forge (`effect`, `@cloudflare/forge`):** `CheckfuApi` defines routes, events, and errors once with Effect `HttpApi` and `Schema`; `tools/forge` generates `openapi.json`, `@checkfu/sdk`, the CLI, and the MCP server.
- **Cloudflare (`@cloudflare/computer`, Durable Objects, D1, R2)** provides a filesystem and on-demand shell for each session. Durable Objects isolate sessions and their workspaces. D1 serves lists, and R2 stores artifacts.

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

- [`apps/api`](apps/api) contains the HTTP/SSE API, domain host, Pi harness, workspaces, OpenAPI, and content Worker.
- [`apps/app`](apps/app): TanStack Router/Query web dashboard Worker
- [`apps/cli`](apps/cli): `checkfu` CLI (`deploy`, `login`, `destroy`, `sessions connect`, resource commands)
- [`apps/mcp`](apps/mcp): Generated HTTP MCP Worker
- [`packages/domain`](packages/domain): Aggregates, decisions, policies, sagas, views, and Z3 proofs
- [`packages/pi-providers`](packages/pi-providers): Model catalog, custom providers, and wire adapters
- [`packages/sdk`](packages/sdk): Effect and Promise SDKs, plus `CheckfuApi`
- [`packages/snapshots`](packages/snapshots): Versioned snapshot codecs
- [`packages/ui`](packages/ui): Dashboard UI components
- [`tools/forge`](tools/forge): OpenAPI, CLI, SDK, and MCP codegen

## Capabilities

| Resource | Endpoint | Purpose |
| :--- | :--- | :--- |
| **Agent** | `/v1/agents` | A reusable configuration with a model and an optional system prompt. Changes create a new version. |
| **Environment** | `/v1/environments` | Configuration for the cloud sandbox where sessions run, including networking settings. |
| **Session** | `/v1/sessions` | An instance of an agent in an environment. It keeps its conversation history and workspace across turns. |
| **Events** | `/v1/sessions/{session_id}/events` | Messages, tool calls and results, and status updates. Send events to the session, list its history, or follow its live SSE stream. |
| **Automation** | `/v1/automations` | Runs an agent in a new session on a cron schedule or on demand. Each run sends the configured initial events and records whether session creation succeeded. |
| **Artifact** | `/v1/artifacts` | A versioned set of files. Share a version with a signed link or publish it as a sandboxed site. |

```text
  Session (PiSession DO)
   ├── Filesystem (SessionWorkspace DO)
   │    ├── /workspace              ◄── Persistent files and on-demand shell
   │    └── /mnt/session/outputs    ──► Saved as an artifact after a completed turn
   │
   └── Tool Execution
        ├── File and shell tools    ──► SessionWorkspace DO + on-demand shell machine
        └── codemode (JS scripts)    ──► CodemodeSandboxWorker (QuickJS)
```

## Interfaces

- **SDK ([`packages/sdk`](packages/sdk/README.md)):** Effect (`CheckfuClient`) and Promise (`new Checkfu()`) clients with retries, idempotency, SSE, and pagination (`GET /openapi.json` for other languages).
- **CLI (`checkfu`):** `bun checkfu --help` or standalone `bun run checkfu:build` with `--format` and GJSON `--transform`.
- **Dashboard:** Sign in with `CHECKFU_API_KEY` to manage resources and stream live session transcripts.
- **MCP** exposes Checkfu API operations as tools. Connect your MCP client to `https://<mcp-worker>.workers.dev/mcp` over HTTP and set the `Authorization` header to `Bearer $CHECKFU_API_KEY`.

## Development

- `bun run generate`: Regenerate `openapi.json`, CLI, SDK, and MCP from `CheckfuApi`
- `bun run check`: Check generated files, `oxfmt`, `oxlint`, directives, and `effect-tsgo`
- `bun run test`: Run unit tests. CI also runs the Z3 proofs. Set `CHECKFU_PROVE=1` to include them locally.
- `bun run test:bun` / `bun run test:workerd`: Bun and `workerd` integration tests
- `bun run checkfu:build`: Build standalone binary at `apps/cli/dist/checkfu`

## License

[Apache 2.0](LICENSE)
