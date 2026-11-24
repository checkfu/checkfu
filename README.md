# Checkfu

Managed agents on Cloudflare, built on Pi Durable, Alchemy, and Effect.

## Deploy your own

You need [Bun](https://bun.sh) 1.4+, Node.js 22.18+, 24 or 26+, a Cloudflare account, and an Anthropic or OpenAI API key. The Workers Paid plan is the safe choice: the free plan allows 10 ms of CPU per request, which an agent turn can exceed.

```sh
git clone https://github.com/checkfu/checkfu && cd checkfu
bun install
bun checkfu deploy
```

`deploy` signs you in to Cloudflare in the browser the first time, asks for your model provider key if it cannot find one, shows what it will create, and deploys four Workers to your account: the API with its Durable Objects, the Pi harness that runs the model calls, the MCP server, and the dashboard. It generates the API key for you and keeps the secrets in the checkout's `.env`. As soon as Alchemy has deployed, it records what this checkout now manages (Cloudflare account, stage, Alchemy profile, URL) in `.checkfu/deployment.json`, waits for the Worker to answer, and saves the URL and key to `~/.config/checkfu/config.json` so every later command already knows where to go. Both files are made owner-only on macOS and Linux; on Windows they are as private as the folder they are in.

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
- **Remove it** — `bun checkfu destroy --stage live` deletes all four Workers and all of their data. It never picks a stage for you, and it only deletes a stage this checkout recorded deploying, in the account it deployed it to. For anything else, use Alchemy directly: `bun run destroy --stage <name>`.

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

## Dashboard

`deploy` prints the dashboard URL as `Dashboard`. Open it and sign in with the same `CHECKFU_API_KEY` to list, create and archive agents, environments and sessions, and to talk to a session as it runs. The dashboard Worker holds the key itself; the browser only gets a signed session cookie that expires after seven days and stops working when the key changes. Locally, `bun run dev` serves it at `http://app-1340.localhost:1340`. Any other local hostname on that port redirects there, so the session cookie is not shared with other local servers or with dashboards running on other ports.

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

### GitHub repositories

Mount repositories when you create a session. Each is cloned into the workspace before the first turn, at `/workspace/<repository>` unless you set `mount_path`:

```sh
curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/sessions" \
  -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg agent "$AGENT_ID" --arg env "$ENV_ID" --arg token "$GITHUB_TOKEN" '{
    agent: $agent,
    environment_id: $env,
    resources: [{
      type: "github_repository",
      url: "https://github.com/acme/api",
      authorization_token: $token,
      checkout: {type: "branch", name: "main"}
    }]
  }')"
```

- `authorization_token` is optional for public repositories. It is held only by the session's workspace, is never returned or shown to the model, and is erased with the workspace. Replace it with `POST /v1/sessions/{session_id}/resources/{resource_id}`.
- `checkout` takes a branch (`{type: "branch", name}`) or a full commit (`{type: "commit", sha}`); the default branch is used without it. A branch is cloned at its latest commit only.
- The agent has a `git` tool: it can commit in the workspace and fetch, pull and push to the session's mounted repositories. No other repository is reachable.
- In an environment with `limited` networking, git reaches GitHub only if `github.com` is in its `allowed_hosts`; the environment's current setting applies from the next turn. Each git request must finish within a minute and send at most 8 MiB.
- A session takes up to 8 repositories. Their mount paths must be inside `/workspace` and must not contain one another.
- If a clone fails, the turn ends with a `session.error` of type `repository_unavailable`, and the next turn tries again.

## Memory stores

A memory store is a set of text memories, each at a path, that outlives any one session:

```sh
STORE_ID=$(curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/memory_stores" \
  -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"User Preferences","description":"Per-user preferences and project context."}' \
  | jq -er '.id')

curl -sS --fail-with-body -X POST "$CHECKFU_URL/v1/memory_stores/$STORE_ID/memories" \
  -H "Authorization: Bearer $CHECKFU_API_KEY" -H "Content-Type: application/json" \
  -d '{"path":"/preferences/formatting.md","content":"Always use tabs, not spaces."}' | jq .
```

- `GET /v1/memory_stores/{id}/memories` lists memories without their content. `path_prefix=/notes/` lists one directory's subtree, and `depth=1` only its own memories.
- `POST /v1/memory_stores/{id}/memories/{memory_id}` replaces a memory's content. Pass `precondition: {type: "content_sha256", content_sha256}` to apply the change only if the memory is unchanged since you read it; a mismatch answers 409.
- A memory's id is derived from its store and path, so creating at a path that holds a memory answers 409.
- A memory holds up to 100 kB at a path of up to 256 characters, and a store up to 1,000 memories.
- `POST /v1/memory_stores/{id}/archive` makes a store read-only. `DELETE` makes it and its memories unreachable.

## Commands

- `bun checkfu --help` — run the Checkfu CLI from this checkout, and only from a **checkout you trust** (`deploy`, `login`, `logout`, `destroy`, `agents`, `environments`, `sessions`, `sessions:events`, `automations`, `automations:runs`). Without `--base-url`, `CHECKFU_API_URL`, or `CHECKFU_URL` it targets the saved deployment, then `http://localhost:1337`; the saved API key is only ever sent to the URL it was saved with.
  - The `checkfu` script starts Bun with `--no-env-file` and the CLI's own `bunfig.toml`, so plain `bun checkfu …` never loads the checkout's `.env` files or a `bunfig.toml` preload into the CLI, and a key in `.env` is not used as if you had exported it. That holds only when nothing in front of the script loads one: `bun --env-file=.env checkfu …`, or any wrapper that sets variables, hands them to the CLI as ordinary environment, which the CLI cannot tell apart from exported values. Alchemy and every other tool you start in the checkout still load `.env` files as Bun normally does. The CLI refuses to start any other way, for example with extra flags passed through `BUN_OPTIONS`.
  - Bun's script runner stays in front of the CLI. On macOS and Linux it passes on Ctrl-C, `SIGTERM` and `SIGHUP`, but not `SIGKILL`, so to force-stop `bun checkfu` there, kill its process group. On Windows there are no signals to pass on: stopping the runner can leave the CLI running, so a supervisor on Windows should start the standalone binary itself. Anything supervised or long-lived is better run with the standalone binary on any platform, since it is one process. The runner also forwards each Ctrl-C a second time, so in `sessions connect` one press interrupts the turn and then disconnects straight away instead of asking for a second press. The standalone binary below has no runner and asks.
  - Outside this checkout, or without Bun on `PATH`, use the standalone binary below and call it by its full path. It is compiled never to load a `.env` or a `bunfig.toml` from the directory it runs in.
- `bun run checkfu:build` — compile the CLI to a single binary at `apps/cli/dist/checkfu`, built so that it never loads a `.env` or `bunfig.toml` from the directory it is run in. It still deploys from this checkout, which it locates from its own path.
- `bun run generate` — regenerate OpenAPI spec and Forge-derived CLI, SDK, and MCP artifacts from `CheckfuApi`
- `bun run check` — verify generated artifacts, format, lint, and typecheck. Tests run in CI; to run the same suites locally, run `bun run test`, `bun run test:bun` and `bun run test:workerd`
- `bun run deploy` — raw `alchemy deploy` to your personal stage, without the secret setup, health check, or saved connection that `bun checkfu deploy` adds. Either way it creates four Workers: the API, which serves HTTP and hosts the domain model, the MCP server, the dashboard, and the Pi harness, which has no public URL, runs the model calls, and is the only one that holds `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- `bun run persisted:cut` → commit `apps/api/test/persisted/Persisted.lock.json` → `bun run deploy:production` — production deploy
  - Until that first baseline is cut, stored shapes may change without a migration: events, states, view rows, receipts and pending two-phase outcomes on a personal stage are not carried across an upgrade. If an upgrade breaks a personal stage, destroy and redeploy it. The baseline is where compatibility starts; after it, a removed shape is retired through the lock.
  - The production stack refuses to build until that baseline is cut and committed, so every `alchemy` command with `--stage production` needs it: `deploy`, `logs`, `drift` and `destroy`. Run them from a checkout whose baseline is shipped.
  - Every resource on the production stage is protected (`RemovalPolicy.protect()`): a plan that would delete or replace one fails before anything changes, including `bun run destroy --stage production`. The Workers hold all the data in their Durable Objects, and the protection does not cover those: a deploy that removes the last binding for a Durable Object class deletes the class and every object in it, and the plan shows it only as an `unbind`. That includes renaming both a class and its binding without `renamedFrom`; renaming only the class under the same binding is a rename and keeps the objects. Read the plan for `unbind` lines before every production deploy. The protection is recorded per resource by a deploy, so a production stage deployed before it was added is not protected until one `bun run deploy:production` has completed with it. To remove production on purpose, deploy once with `protectInProduction` taken out of `alchemy.run.ts`, then destroy.
