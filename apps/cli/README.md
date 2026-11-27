# checkfu

The Checkfu command-line client. Requires Node.js 22 or later.

```sh
npm install -g checkfu
checkfu --help
```

Connect to your staging deployment. The key is entered privately when using a terminal; scripts can export `CHECKFU_API_KEY`.

```sh
checkfu --base-url https://your-api.workers.dev login
checkfu agents list
checkfu sessions connect SESSION_ID
```

Author agents, environments and automations in YAML, JSON or Markdown, preview the changes, then apply them:

```sh
checkfu agent info agents/assistant.md
checkfu apply . --dry-run
checkfu apply . --yes
```

Keep `checkfu-lock.json` with the project. It records resource IDs and versions. Remote edits are refused until you explicitly reconcile them. Use `--format json` for scripts, `--transform id` to extract fields, and `--help` on any command to inspect its inputs.

The npm CLI runs without Bun and ignores `.env` and Bun configuration files in the current directory. It saves connections in the user's Checkfu configuration directory. Use `checkfu logout` to remove a saved connection.

## Deploying a Checkfu server

Deploy from any directory:

```sh
checkfu deploy
```

The CLI signs in to your Cloudflare account, prompts privately for a model provider key, deploys Checkfu, and saves the connection. Your account needs Workers Paid and R2 enabled. Bun and deployment dependencies are downloaded into a private Checkfu cache automatically. You do not need a source checkout or Docker.

The server and sandbox definition come from the exact `origin/main` commit whose CI has passed. A pending or failed CI run stops deployment with a clear message. Server changes do not require an npm CLI update.

Run `checkfu deploy` again to update the same deployment, preserving its key, stage, account, and stored data. Use `--stage staging` to create or select a separate deployment; subsequent deploys remember the last selected stage. Settings and credentials live under `~/.config/checkfu` (or `CHECKFU_CONFIG_DIR`), separately from the source cache and globally installed npm package.

To permanently delete a deployment and its data, explicitly name the stage:

```sh
checkfu destroy --stage live
checkfu deploy
```

Destroy asks for confirmation; `--yes` skips it for scripts. Deploying afterwards creates the selected stage again. Destroy uses the recorded source revision, so it does not depend on main's current CI status. A failed deploy keeps enough information to retry or destroy it. Updates use `deploy`; destruction is for deleting data.

For unattended initial deployment, export a model provider key (for example `OPENAI_API_KEY`), `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`, then run `checkfu deploy --yes`. The CLI generates and saves a stable Checkfu API key. Export `CHECKFU_API_KEY` as well if you need to supply your own. Deployment on macOS and Linux arm64/x64 is supported; Windows deployment is not yet qualified.

Update the CLI itself with `npm install -g checkfu@latest`. See the [project documentation](https://github.com/checkfu/checkfu#readme) for provider configuration and project examples.
