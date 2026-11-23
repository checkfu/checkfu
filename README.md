# Checkfu

Managed agents on Cloudflare, built on Pi Durable, Alchemy, and Effect.

## Run locally

Initialize `.env` (if not present), then set `CHECKFU_API_KEY` plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`:

```sh
[ -f .env ] || cp .env.example .env
bun install
bun run dev
```

`bun run dev` prints the local Worker URL (for example `http://localhost:1337`). `GET /health` and `GET /openapi.json` are public; `/v1/*` routes accept `Authorization: Bearer <key>` or `x-api-key: <key>`.

## Quickstart

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

## Commands

- `node apps/cli/bin/checkfu.mjs --help` — run the Checkfu CLI from a **trusted Checkfu source checkout** (`agents`, `environments`, `sessions`, `sessions:events`).
  - **Untrusted checkouts with `CHECKFU_API_KEY` exported:** invoke an independently installed Checkfu launcher using **absolute paths for both Node and `checkfu.mjs`** (e.g., `/usr/bin/node /opt/checkfu/apps/cli/bin/checkfu.mjs --help` on POSIX or `C:\Program Files\nodejs\node.exe C:\Users\<user>\checkfu\apps\cli\bin\checkfu.mjs --help` on Windows). Never run a relative `apps/cli/bin/checkfu.mjs` inside an untrusted checkout.
  - **`PATH`-based `checkfu` bin (`#!/usr/bin/env node`):** requires both `checkfu` and `node` on `PATH` to resolve to trusted installations before the launcher starts (do not rely on the `PATH`-based bin when `PATH` may contain `.`, empty entries, or project-local directories). Once started, the launcher resolves Bun only from explicitly trusted installation roots (or `BUN_INSTALL` / `CHECKFU_BUN_PATH` outside the enclosing checkout) and pins `--no-env-file --config=<install>/bunfig.toml`.
- `bun run generate` — regenerate OpenAPI spec and Forge-derived CLI commands from `CheckfuApi`
- `bun run check` — verify generated artifacts, format, lint, typecheck, and test all packages
- `bun run deploy` — deploy to your default Cloudflare stage
- `bun run persisted:cut` → commit `apps/api/test/persisted/Persisted.lock.json` → `bun run deploy:production` — production deploy
