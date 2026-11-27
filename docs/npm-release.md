# Preparing the npm clients

The source workspace stays private. `release:build` produces the two public packages in `dist/npm/checkfu` and `dist/npm/sdk`, with explicit file allowlists and npm-compatible dependency versions. No publish command runs during build or verification.

```sh
bun install --frozen-lockfile
bun run check
bun run --cwd apps/cli test
bun run --cwd packages/sdk test
bun run --cwd tools/release test
bun run --cwd apps/api test:workerd -t 'takes a YAML project'
bun run release:build
npm pack ./dist/npm/checkfu --ignore-scripts
npm pack ./dist/npm/sdk --ignore-scripts
```

The package contract builds and packs both packages, installs their tarballs outside the checkout with install scripts disabled, checks TypeScript consumption, and drives the installed clients over HTTP against production API handlers and the domain backend. It checks login failure without saved credentials, private successful login, CLI writes read back by the SDK, two piped conversation turns including EOF without a final newline, idempotent retries, conflict refusal, historical versions and pagination, typed errors, Promise and Effect clients, SSE, logout, and resistance to a project's `.env` and Bun preloads. Consumer processes have no Bun in their PATH and run with TypeScript stripping disabled. The Workers project journey installs the actual npm CLI tarball offline before exercising apply/run/output/history/drift/concurrency/prune contracts. Native standalone binaries retain their separate tests.

The ordinary CI test job covers Node 24 on Linux. The npm package workflow also tests Node 22 on Linux and macOS. Windows has not been qualified by this release workflow.

The CLI is a bundled JavaScript executable requiring Node 22 or later, with no runtime npm dependencies or install script. Bun is used to build it, not to run it. Server deployment still requires a source checkout and Bun; `checkfu deploy` from the npm distribution gives those instructions. The SDK ships ESM JavaScript and declarations and depends on the exact Effect version used for qualification.

The CLI build includes third-party license notices from Bun's actual module graph. Its package metadata version is also the CLI's displayed version. The SDK error constructor types must remain declaration-emittable; source-only typechecks do not establish that.

The runtime checks also require a fresh machine to write directly to `/mnt/session/outputs` without preparing that directory itself. The terminal session checks require failed tool results to remain visible when the agent recovers, with bounded output and escaped terminal controls. Both checks reproduced failures during the first npm qualification before the corresponding fixes.

Before publishing, rerun the gates on the chosen commit, inspect both `npm pack --json` file lists, confirm the candidate tarballs contain no credentials, and perform a short staging turn using the installed CLI. Archive the session, prune the test project, destroy the disposable deployment, and remove its owned registry image tag.

Once the artifacts have been reviewed, the maintainer publishes the built directories:

```sh
npm publish ./dist/npm/sdk --access public
npm publish ./dist/npm/checkfu --access public
```

Publishing requires the maintainer's npm authentication and any required OTP. Those credentials are not required to build, install or verify the release candidates. Do not publish the private workspace directories.
