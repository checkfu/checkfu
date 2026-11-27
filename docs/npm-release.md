# Preparing the npm CLI

The CLI patch is **checkfu 0.0.2**. The SDK remains **@checkfu/sdk 0.0.1** and is not republished for this CLI change. npm versions cannot be replaced after publication.

The private workspace builds the public packages into `dist/npm/checkfu` and `dist/npm/sdk`. Build and verification never publish.

```sh
bun install --frozen-lockfile
bun run check
bun run --cwd apps/cli test
bun run --cwd tools/release test
bun run --cwd apps/api test:workerd
bun run release:build --cli-only
npm pack ./dist/npm/checkfu --ignore-scripts
```

The package contract packs and installs outside the checkout with install scripts disabled. Consumer processes have no global Bun and disable TypeScript stripping. They drive login, every generated CLI command, resource lifecycles, version conflicts, memory preconditions, binary artifact bytes, credential redaction, session resources and token replacement, webhook lifecycle and deliveries, automation runs, streaming, two piped turns including EOF without a newline, local authoring, apply and unchanged plans. Backend reads independently verify writes. The command inventory makes an added generated command require a journey. Promise/Effect SDK consumers and strict external TypeScript compilation remain cross-checks; the SDK tarball built by the test is not a publication instruction.

A second deployment contract extracts only version-controlled source into a clean external directory, downloads and verifies the actual Bun runtime, installs frozen dependencies with lifecycle scripts disabled, builds the dashboard with managed tooling, and checks the shipped persisted-data baseline without system Bun or Git. A changed baseline must fail. macOS and Linux Node 22 run in the npm workflow; ordinary CI covers Node 24. Windows deployment is not qualified.

Managed deploy tests cover immutable source, fetching the latest main revision once per invocation without a CI gate, source lookup failure before cloud mutation, stage isolation, preserved secrets/data, corrupt runtime/source caches, interrupted installation, and cancellation that finishes cleanup before releasing the deployment lock. The deployment engine test uses real Alchemy plans and state: a normal update keeps stored data, replacement/deletion is refused even with `--yes`, a declined plan does not apply, and explicit destroy followed by a new deployment works. Filesystem tests retain project boundary protections while accepting aliases of the project root, including macOS `/var` and `/private/var`.

Server deployment is independent of the npm CLI version. `checkfu.deployment.json` defines the supported deployment protocol and runtime downloads. `checkfu deploy` resolves the latest main SHA and downloads its immutable source archive immediately. The source cache and runtime are separate from private per-stage settings and connection credentials. Destroy uses the recorded revision instead of current main.

CI publishes the sandbox image from main's build context when it changes, after the other checks pass. `ghcr.io/checkfu/sandbox` must remain publicly readable, with the `checkfu/checkfu` workflow granted Write access. The server-side deployment helper verifies image digests and copies missing layers into the customer's Cloudflare registry over HTTP. Users need no GitHub login, source checkout, global Bun, or Docker. Changing server or sandbox code does not require another CLI release.

Before publishing, rebase onto main and require every gate on the exact release commit. Inspect the npm file list and scan the candidate for actual credential values without printing them. Install the candidate into an isolated prefix and perform one cost-bounded staging lifecycle: deploy, use the CLI and a real model, repeat deploy, update from a later CI-passing main revision with data intact, refuse the wrong stage/account, explicitly destroy, deploy again, and destroy again. Independently verify that disposable resources and their owned image tags are gone. Keep release evidence under `.checkfu/cli-qualification.md`.

Only after qualification, publish the CLI directory:

```sh
npm publish ./dist/npm/checkfu --access public
```

Publication uses the maintainer's npm authentication and any required web/OTP approval. Then verify a fresh anonymous install of `checkfu@latest`, its version, and the public tarball's integrity against the tested candidate. A GitHub Release is not required.
