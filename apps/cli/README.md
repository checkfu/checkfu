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

Deployment currently requires a source checkout and Bun:

```sh
git clone https://github.com/checkfu/checkfu
cd checkfu
bun install
bun checkfu deploy --stage staging
```

See the [project documentation](https://github.com/checkfu/checkfu#readme) for provider configuration and project examples. The npm client connects to an existing deployment; it does not contain the deployment stack.
