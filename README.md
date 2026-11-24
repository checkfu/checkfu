# Checkfu

Managed agents on Cloudflare, built on Pi Durable, Alchemy, and Effect.

## Deploy your own

You need [Bun](https://bun.sh) 1.4+, Node.js 22.18+, 24 or 26+, a Cloudflare account, and an Anthropic or OpenAI API key. The Workers Paid plan is the safe choice: the free plan allows 10 ms of CPU per request, which an agent turn can exceed.

```sh
git clone https://github.com/checkfu/checkfu && cd checkfu
bun install
bun checkfu deploy
```

`deploy` signs you in to Cloudflare in the browser the first time, asks for your model provider key if it cannot find one, shows what it will create, and deploys five Workers to your account: the API with its Durable Objects, the Pi harness that runs the model calls, the sandbox that runs the agent's scripts, the connection Worker that holds credential secrets and sends every request to MCP servers and APIs, and the MCP server. It generates the API key for you and keeps the secrets in the checkout's `.env`. As soon as Alchemy has deployed, it records what this checkout now manages (Cloudflare account, stage, Alchemy profile, URL) in `.checkfu/deployment.json`, waits for the Worker to answer, and saves the URL and key to `~/.config/checkfu/config.json` so every later command already knows where to go. Both files are made owner-only on macOS and Linux; on Windows they are as private as the folder they are in.

Then create an agent, an environment, and a session, and connect to it. Each command prints the ID the next one needs:

```sh
bun checkfu agents create --name Assistant --model claude-sonnet-5-5
bun checkfu environments create --name default
bun checkfu sessions create --agent-id <agent-id> --environment-id <environment-id>
bun checkfu sessions connect <session-id>
```

Use `gpt-6.2-sol` if you deployed with an OpenAI key. A coding agent can drive the same steps from `bun checkfu --help` or `GET <your-url>/openapi.json`.

After that:

- **Upgrade** — `git pull && bun install && bun checkfu deploy`. It reuses the recorded stage and the secrets in `.env`, and shows the changes before applying them. It stops before changing anything if your credentials now act on a different Cloudflare account than the one this checkout deployed that stage to; delete `.checkfu/deployment.json` if you mean to move it.
- **Use it over MCP** — `deploy` prints the MCP URL; add it to your client with the same key (see [MCP](#mcp)).
- **Call the API from your own code** — the URL and key are in `~/.config/checkfu/config.json`; `/v1/*` routes accept `Authorization: Bearer <key>` or `x-api-key: <key>`. `GET /v1/auth/verify` tells you whether a key is accepted.
- **Use it from another machine** — `bun checkfu --base-url https://<your-worker>.workers.dev login`.
- **Deploy from CI** — export `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, a model provider key, and a persistent `CHECKFU_API_KEY` (the one from your first deploy, or `openssl rand -hex 32`), then run `bun checkfu deploy --yes`. Without a terminal the deploy refuses to invent an API key, because a fresh runner would rotate it on every run.
- **Use your own hostnames** — set `CHECKFU_API_DOMAIN` and `CHECKFU_MCP_DOMAIN` in `.env` (for example `api.example.com` and `mcp.example.com`) and deploy again. Each zone has to be in the Cloudflare account you deploy to, and `deploy` then reports those addresses; the `workers.dev` ones keep working too. A hostname set here replaces every custom hostname on that Worker, including any you attached in the Cloudflare dashboard. To go back, set the variable to `none` and deploy: emptying it leaves attached hostnames in place, as long as your shell does not export it either, since an empty `.env` entry falls back to the shell. To change a hostname, set `none` and deploy first, then the new one: a one-step change detaches the old hostname before attaching the new, so a new hostname that cannot be attached leaves the Worker with neither.
- **Remove it** — `bun checkfu destroy --stage live` deletes all three Workers and all of their data. It never picks a stage for you, and it only deletes a stage this checkout recorded deploying, in the account it deployed it to. For anything else, use Alchemy directly: `bun run destroy --stage <name>`.

## Run locally

Initialize `.env` (if not present), then set `CHECKFU_API_KEY` plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (a `.env` written by `bun checkfu deploy` already has them):

```sh
[ -f .env ] || cp .env.example .env
bun install
bun run dev
```

`bun run dev` prints the local Worker URL (for example `http://localhost:1337`). `GET /health` and `GET /openapi.json` are public; `/v1/*` routes accept `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Quickstart with curl

In another terminal (requires `curl` and `jq`), set `CHECKFU_API_KEY` to match `.env` and `CHECKFU_MODEL` to match your provider key (`gpt-6.2-sol` for `OPENAI_API_KEY` or `claude-sonnet-5-5` for `ANTHROPIC_API_KEY`). This creates an agent, environment, and session, sends a message, and streams events from the start (`Ctrl-C` to exit):

```sh
(
  set -euo pipefail
  CHECKFU_URL="http://localhost:1337"
  CHECKFU_API_KEY="<same key from .env>"
  CHECKFU_MODEL="gpt-6.2-sol"

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

## SDK

`@checkfu/sdk` ([packages/sdk/README.md](packages/sdk/README.md)) provides an Effect-native client (`CheckfuClient` service + `Layer`s + `Stream`s + `Data.TaggedError`s) and a thin Promise / `AsyncIterable` facade (`new Checkfu(...)`) sharing the single-source `CheckfuApi` contract with the server and CLI.

## MCP

`bun run dev` also starts the MCP server and prints its URL as `mcp` (`http://localhost:1338` unless that port is taken). It offers one tool per API operation, generated from the same `CheckfuApi` contract as the CLI, and passes your `CHECKFU_API_KEY` through to the API:

```sh
CHECKFU_MCP_URL="<mcp URL printed by bun run dev>"
CHECKFU_API_KEY="<same key from .env>"
claude mcp add --transport http checkfu "$CHECKFU_MCP_URL/mcp" \
  --header "Authorization: Bearer ${CHECKFU_API_KEY:?set CHECKFU_API_KEY first}"
```

`claude mcp add` saves that URL and the key. The entry outlives `bun run dev`, and Claude will keep sending the key to that port whatever is listening there later, so run `claude mcp remove checkfu` when you stop the dev server. Keep a saved entry only for a deployed `https://` URL.

For a deployment, use the `MCP` URL that `bun checkfu deploy` prints and the key in `~/.config/checkfu/config.json`.

The server speaks MCP revision `2026-07-28`. It deploys as its own Worker (`McpWorker`) next to the API and reaches it over a service binding.

## Session workspace

Every session has a durable workspace: a filesystem that lasts for the whole session and survives restarts. The agent works in it with `read`, `ls`, `find`, `grep`, `write`, `edit` and `delete` tools, starting from `/workspace`. The workspace runs in the harness Worker, beside the session object whose tools use it, and the API reaches it only through that Worker. It is discarded when the session terminates.

## Scripts

The agent can also write a JavaScript script that calls its tools (`await tools.read({ ... })`) with the `codemode` tool, so a chain of calls costs one model round trip. Scripts run in a sandbox with no network, files or timers, hosted by a second Worker (`CodemodeSandboxWorker`, `http://localhost:1340` under `bun run dev`) so a busy script cannot stall its session. A script that computes without calling a tool is stopped after about ten seconds of CPU, and one that waits is stopped after two minutes unless it asks for up to five. A script that was cut off by a restart resumes without repeating the calls it finished.

## Vaults

A vault holds credentials for agents to use. Create one with `POST /v1/vaults`, then store a bearer token for an MCP server with `POST /v1/vaults/{vault_id}/credentials`. A vault holds up to 20 active credentials, one per MCP server or API base URL. A credential's secret is kept only by that credential's own Durable Object: it is never returned, and it is erased when the credential or its vault is archived or deleted.

A credential can also hold an OAuth grant (`"type": "mcp_oauth"`): the `access_token` your application obtained, its `expires_at`, and optionally `refresh` (`token_endpoint`, `client_id`, `refresh_token`, `token_endpoint_auth`). With `refresh`, the credential's object renews the access token shortly before it expires, or when the MCP server stops accepting it, and makes one refresh however many sessions are calling. If the authorization server refuses the refresh, the credential shows `refresh_failed_at`, calls to that server fail with a message saying it needs re-authorizing, and nothing is retried until you update the credential with new tokens. Checkfu does not run the sign-in flow itself.

A credential can also be a key for a plain HTTP API (`"type": "api_key"`): its `base_url`, the `token`, and `placement`, which says where the key goes in each request: `{ "in": "header", "name": "Authorization", "prefix": "Bearer " }` or `{ "in": "query", "name": "api_key" }`. The key is only ever sent to that base URL's origin, under its path. An API key is used by API servers only, and a bearer token or OAuth grant by MCP servers only.

## MCP servers

An agent lists the MCP servers it uses in `mcp_servers` (`{ "type": "url", "name": "tracker", "url": "https://..." }`). A session decides which credential each server gets when it is created: pass `vault_ids`, and a server is bound to the one credential those vaults store for its URL; when more than one matches, the request is refused until `mcp_server_credentials` names the credential (`{ "mcp_server_name": "tracker", "credential_id": "vcrd_..." }`). A server with no credential is used without one. The binding is fixed for the session and shown on it as `mcp_servers`; the secret is read at each call, so a rotated token applies at once and an archived credential stops working.

The agent reaches a server's tools from scripts as `tools.mcp__<server>__<tool>(...)`, or calls one directly after `tool_search` has loaded it. Every request to the server is made by the credential's own Durable Object, which sends the secret only to the URL it was stored for. Each call is on the session's event log as `agent.mcp_tool_use` and `agent.mcp_tool_result`, with `parent_tool_use_id` naming the script call when a script made it.

## API servers

An agent can call any HTTP API that has an OpenAPI document. List it in `api_servers`: `{ "type": "openapi", "name": "shop", "base_url": "https://api.shop.example/v1", "spec": { ...the OpenAPI 3.0 or 3.1 document as JSON... } }`. Each operation becomes a tool named by its `operationId`. `include` and `exclude` (`{ "names": [...], "tags": [...] }`) pick operations by name or tag. A document is at most 2 MB of JSON, a server has at most 256 operations after `include` and `exclude`, whose tool descriptions come to at most 1 MB, and an agent has at most 4 API servers; a name cannot also be one of the agent's MCP servers. The document is stored once, by a Durable Object of its own, and is never returned: the agent shows its title, version, number of operations and digest. Updating an agent keeps its API servers unless `api_servers` is sent, and each server sent again needs its document again.

A session binds each API server to an `api_key` credential the way it binds MCP servers: by `vault_ids` and the server's `base_url`, or by `api_server_credentials` (`{ "api_server_name": "shop", "credential_id": "vcrd_..." }`), and two matching keys are refused rather than picked from. A `limited` environment must list the API's host in `allowed_hosts`.

The agent calls an operation from scripts as `tools.api__<server>__<operation>({ path, query, headers, body })`, or directly after `tool_search` has loaded it. A script gets `{ status, body }`, with `body` parsed when the response is JSON of the documented shape and `text` otherwise. The request is built from the document and sent by the credential's own Durable Object, which attaches the key, follows no redirect, waits at most 60 seconds, returns at most 100,000 characters of the response, and replaces the key with `[redacted]` wherever the response repeats it. A response that is not 2xx is a tool error carrying its status. Each call is on the session's event log as `agent.api_tool_use` and `agent.api_tool_result`.

Without a policy, an operation whose HTTP method only reads (GET, HEAD, OPTIONS) runs and every other operation asks first. Set policies per server with `{ "type": "api_toolset", "api_server_name": "shop", ... }` in `tools`, as for an `mcp_toolset` below.

## Tool approvals

An MCP tool or API operation either runs on its own or waits for a person. The agent decides per server in `tools`: `{ "type": "mcp_toolset", "mcp_server_name": "tracker", "default_config": { "permission_policy": { "type": "always_ask" } }, "configs": [{ "name": "search", "permission_policy": { "type": "always_allow" } }] }`. A tool's own entry wins over the server's default. With neither, a tool the server marks read-only runs and every other tool asks; that mark is the server's own claim, so set `always_ask` where it should not be trusted. Each `agent.mcp_tool_use` event says how the call was let through in `evaluated_permission` (`allow` or `ask`).

When the agent calls a tool that asks, the tool does not run. The session goes idle with `stop_reason: { "type": "requires_action", "event_ids": [...] }`, where each id is the `tool_use_id` of a waiting `agent.mcp_tool_use` or `agent.api_tool_use` event, and nothing runs while it waits. Answer each with a `user.tool_confirmation` event: `{ "type": "user.tool_confirmation", "tool_use_id": "...", "result": "allow" }`, or `"deny"` with an optional `deny_message` the agent is told. The first answer sets the session running again; if other calls still wait, it goes idle again naming those. While it waits a session takes no `user.message` (409); a `user.interrupt` gives the waiting calls up, after which their answers are refused.

A script cannot wait for a person. A call from a script to a tool that asks is refused at once with a message telling the agent to make the call directly.

## Custom tools

A custom tool is one your own application runs. Declare it on the agent in `tools`: `{ "type": "custom", "name": "lookup_order", "description": "Look an order up.", "input_schema": { "type": "object", "properties": { "order": { "type": "string" } } } }`. A name is 1 to 64 letters, digits, underscores or hyphens, and cannot start with `mcp__` or `api__` or be the name of a built-in tool; an agent has at most 64 custom tools.

When the agent calls one, the session records `agent.custom_tool_use` with the call's `tool_use_id`, `name` and `input`, and goes idle with `stop_reason: { "type": "requires_action", "event_ids": [...] }`, holding no compute while it waits. Run the tool and send its result: `{ "type": "user.custom_tool_result", "custom_tool_use_id": "<tool_use_id>", "content": [{ "type": "text", "text": "shipped" }] }`, with `"is_error": true` if it failed. The result is text, at most 16,384 characters; several text blocks are joined with newlines and recorded as one. A result for a call that is not waiting is refused (409), as is a `user.tool_confirmation` for a custom tool call. Custom tool calls and calls that wait for approval can share one pause; each takes its own answer, and the session resumes on the first.

Only the agent calls a custom tool. It is not available inside scripts, which cannot wait for an answer from outside.

## Commands

- `bun checkfu --help` — run the Checkfu CLI from this checkout, and only from a **checkout you trust** (`deploy`, `login`, `logout`, `destroy`, `agents`, `environments`, `sessions`, `sessions:events`, `automations`, `automations:runs`, `vaults`, `vaults:credentials`). Without `--base-url`, `CHECKFU_API_URL`, or `CHECKFU_URL` it targets the saved deployment, then `http://localhost:1337`; the saved API key is only ever sent to the URL it was saved with.
  - The `checkfu` script starts Bun with `--no-env-file` and the CLI's own `bunfig.toml`, so plain `bun checkfu …` never loads the checkout's `.env` files or a `bunfig.toml` preload into the CLI, and a key in `.env` is not used as if you had exported it. That holds only when nothing in front of the script loads one: `bun --env-file=.env checkfu …`, or any wrapper that sets variables, hands them to the CLI as ordinary environment, which the CLI cannot tell apart from exported values. Alchemy and every other tool you start in the checkout still load `.env` files as Bun normally does. The CLI refuses to start any other way, for example with extra flags passed through `BUN_OPTIONS`.
  - Bun's script runner stays in front of the CLI. On macOS and Linux it passes on Ctrl-C, `SIGTERM` and `SIGHUP`, but not `SIGKILL`, so to force-stop `bun checkfu` there, kill its process group. On Windows there are no signals to pass on: stopping the runner can leave the CLI running, so a supervisor on Windows should start the standalone binary itself. Anything supervised or long-lived is better run with the standalone binary on any platform, since it is one process. The runner also forwards each Ctrl-C a second time, so in `sessions connect` one press interrupts the turn and then disconnects straight away instead of asking for a second press. The standalone binary below has no runner and asks.
  - Outside this checkout, or without Bun on `PATH`, use the standalone binary below and call it by its full path. It is compiled never to load a `.env` or a `bunfig.toml` from the directory it runs in.
- `bun run checkfu:build` — compile the CLI to a single binary at `apps/cli/dist/checkfu`, built so that it never loads a `.env` or `bunfig.toml` from the directory it is run in. It still deploys from this checkout, which it locates from its own path.
- `bun run generate` — regenerate OpenAPI spec and Forge-derived CLI, SDK, and MCP artifacts from `CheckfuApi`
- `bun run check` — verify generated artifacts, format, lint, and typecheck. Tests run in CI; to run the same suites locally, run `bun run test`, `bun run test:bun` and `bun run test:workerd`
- `bun run deploy` — raw `alchemy deploy` to your personal stage, without the secret setup, health check, or saved connection that `bun checkfu deploy` adds. Either way it creates five Workers: the API, which serves HTTP and hosts the domain model, the MCP server, the code-mode sandbox, the connection Worker, which has no public URL and no Workers Traces so a key sent in a URL is not recorded, and the Pi harness, which has no public URL, runs the model calls, and is the only one that holds `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- `bun run persisted:cut` → commit `apps/api/test/persisted/Persisted.lock.json` → `bun run deploy:production` — production deploy
  - Until that first baseline is cut, stored shapes may change without a migration: events, states, view rows, receipts and pending two-phase outcomes on a personal stage are not carried across an upgrade. If an upgrade breaks a personal stage, destroy and redeploy it. The baseline is where compatibility starts; after it, a removed shape is retired through the lock.
  - The production stack refuses to build until that baseline is cut and committed, so every `alchemy` command with `--stage production` needs it: `deploy`, `logs`, `drift` and `destroy`. Run them from a checkout whose baseline is shipped.
  - Every resource on the production stage is protected (`RemovalPolicy.protect()`): a plan that would delete or replace one fails before anything changes, including `bun run destroy --stage production`. The Workers hold all the data in their Durable Objects. The protection is recorded per resource by a deploy, so a production stage deployed before it was added is not protected until one `bun run deploy:production` has completed with it. To remove production on purpose, deploy once with `protectInProduction` taken out of `alchemy.run.ts`, then destroy.
