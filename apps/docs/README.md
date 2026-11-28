# Checkfu docs

Mintlify source for [docs.checkfu.com](https://docs.checkfu.com). Writing rules and sources of truth are in [`AGENTS.md`](AGENTS.md).

## Preview

```sh
cd apps/docs
bun x mint@4.2.933 dev --port 3002
```

Check links and configuration before opening a pull request:

```sh
bun x mint@4.2.933 broken-links
bun x mint@4.2.933 validate
```

`openapi.json` drives the HTTP API reference under `/api-reference`. It is generated from `CheckfuApi` with the rest of the codegen; run `bun run generate` from the repository root after changing the API, and `bun run generate:check` fails if it is stale.

## Deployment

Mintlify builds this directory from `main` of `checkfu/checkfu` (monorepo path `/apps/docs`) and serves it at `docs.checkfu.com` (`CNAME docs` → `cname.mintlify.builders`).
