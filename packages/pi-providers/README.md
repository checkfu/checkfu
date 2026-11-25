# `@checkfu/pi-providers`

Edge-hardened, extensible provider registry and wire-format runtime for `@earendil-works/pi-ai` and `@earendil-works/pi-durable`.

## Entrypoints

- **`@checkfu/pi-providers/catalog`**: Zero vendor SDKs, zero Pi runtime. Declarative provider specs, model specifier parsing (`<provider>/<model-id>` + bare aliases), credential checks, and base URL validation. Safe in public API Workers, CLIs, and browsers.
- **`@checkfu/pi-providers/runtime`**: Statically imported (non-lazy, Durable-Object-safe) wire codecs for `anthropic-messages`, `openai-responses`, and `openai-completions`, wrapped with origin-pinned no-redirect fetch, wire-level refusal guards, and dynamic Day-1 unlisted-model resolution.
- **`@checkfu/pi-providers/refusals`**: Wire-format refusal predicates and normalization helpers.
- **`@checkfu/pi-providers/fetch`**: Origin-pinned no-redirect `fetch` wrapper and strict base URL validators.

## Built-in providers

- `openai` (`OPENAI_API_KEY`, OpenAI Responses API)
- `anthropic` (`ANTHROPIC_API_KEY`, Anthropic Messages API)
- `openrouter` (`OPENROUTER_API_KEY`, routing Claude models to native Anthropic Messages and other models to OpenAI Chat Completions)
- `cloudflare-ai-gateway` (`CLOUDFLARE_GATEWAY_ID` + `CLOUDFLARE_AI_API_KEY`/`CLOUDFLARE_ACCOUNT_ID` over HTTPS, or zero-token native Cloudflare Worker `AI` binding passthrough)
- `cloudflare-workers-ai` (`CLOUDFLARE_AI_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`, OpenAI-compatible Workers AI endpoint)
