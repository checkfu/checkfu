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
bun checkfu agents create --name Assistant --model your-model-id
bun checkfu environments create --name default
bun checkfu sessions create --agent <agent-id> --environment-id <environment-id>
bun checkfu sessions connect <session-id>
```

Send a message in `sessions connect` to start work and follow the session's events live.

Use a model ID configured for your deployment.

### Configuration as code

Keep agent, environment, and cron automation definitions in your project as YAML, JSON, or Markdown with frontmatter. Each file contains the fields accepted by the corresponding create endpoint. Checkfu infers the resource type from its directory, a filename such as `agent-support.yaml`, or a top-level `type` field.

`agents/support.md`

```md
---
name: Support
model: your-model-id
---

Answer support questions and cite the source you used.
```

`environments/cloud.yaml`

```yaml
name: Cloud
```

`automations/report.yaml`

```yaml
name: Weekday report
agent: ../agents/support.md
environment_id: ../environments/cloud.yaml
initial_events:
  - type: user.message
    content:
      - type: text
        text: Write the daily support report.
schedule:
  type: cron
  expression: "0 9 * * 1-5"
  timezone: America/New_York
```

```sh
checkfu agent info agents/support.md
checkfu apply . --dry-run
checkfu apply . --yes
checkfu apply --yes
```

In a Markdown automation file, put the initial message below the frontmatter or set `initial_events` in the frontmatter. Markdown prose uses LF line endings. Use a quoted frontmatter string with explicit escapes for prompts that require literal CRLF.

Run the commands from the project directory. In this source checkout, use `bun checkfu` in place of the standalone `checkfu` binary. `agent info` validates locally. `apply` resolves relative references before creating the resources that use them. A relative agent reference pins the version applied in the same run. Use `agent: {path: ../agents/support.md, version: 1}` to keep a specific version, or use an agent ID string to follow its latest version.

Keep `checkfu-lock.json` with the project. It records resource IDs and configuration fingerprints for one API URL. With no paths, `apply` reconciles the files already tracked in the lockfile. Directory discovery stops at nested projects with their own lockfiles.

Review remote edits with `--dry-run`, use `--force` to overwrite them, and use `--prune` to archive resources whose files were deleted within the selected paths. You can scope pruning to a deleted directory if the lockfile tracks files under it. Omit paths to prune across the tracked project. Apply checks pending automation creates in the project, and the server checks live automation references in the same operation that archives an agent or environment. Pruning and applying automation updates require an API deployment that supports revision checks.

For an environment file without `config`, apply uses the default cloud networking policy. If a create was interrupted, keep the original definition and lockfile and rerun apply to confirm that request before editing it.

In the dashboard, switch between **Form** and **YAML** when creating or editing an agent. An agent’s **YAML** view can be copied, and **Export as code** downloads a Markdown definition and its `checkfu-lock.json`. Unzip the project and run `checkfu apply --dry-run` against the same API deployment. Editing the exported definition and applying it updates that agent.

For editor completion, add a YAML Language Server schema comment pointing to `/schemas/apply/agent.json`, `/schemas/apply/environment.json`, or `/schemas/apply/automation.json` on your Checkfu API. Agent exports include this comment automatically.

### Local dev

Set `CHECKFU_API_KEY` and the credentials for your model provider in `.env`. See [the example environment file](.env.example) for variable names.

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
- [`packages/authoring`](packages/authoring): Project file parsing, validation, and lockfile format shared by the dashboard and CLI
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
