# Checkfu

Managed agents on Cloudflare.

In `.env`, set these keys:

- `CHECKFU_API_KEY` — Generate a secret with `openssl rand -hex 32`. Clients use it to call Checkfu.
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` — Use the API key from your model provider.

```sh
bun install
bun run check
bun run dev
```
