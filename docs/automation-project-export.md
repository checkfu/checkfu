# Automation project export

## Reference semantics

Export the saved configuration of an automation whose archived_at is null as an apply project for its source deployment. The response contains the resolved agent ID and version and the environment ID. Whether the author used a literal pin, an unversioned ID, or a relative path is unavailable. Preserve the resolved binding. [Automation resource](../packages/sdk/src/Api.ts#L1060) · [Apply reference resolution](../apps/cli/src/Project/Source.ts#L252)

| Configuration | Exported representation |
| --- | --- |
| `name` and `description` | Preserve both, including a null description. |
| `agent` | Write `{type: agent, id: <saved ID>, version: <saved version>}`. A newer head can coexist with that historical version. |
| `environment_id` | Preserve the saved identity. The automation has no environment version pin. |
| `initial_events` | Write the returned events in a YAML field to preserve the prompt verbatim. The API serializes the stored prompt as one user message with one text block, and apply compares that canonical shape. |
| `schedule` | Preserve its type, cron expression and time zone. |
| Revision, operational state, and timestamps | The create definition contains the configuration above. The lock carries the automation ID and configuration hash. Apply reads the live revision before it prepares an update. |

A bare agent ID resolves the current head on each apply. The saved automation then has a concrete pin. A relative path uses the version resolved during that apply unless its object specifies a version. An export preserves the saved pin even when it came from a moving reference. A user can edit the resulting definition to opt into resolving the head on a later apply. [Project examples](../README.md#L83) · [Create fields](../packages/sdk/src/Api.ts#L804) · [CLI normalization and resolution](../apps/cli/src/Project/Resources.ts#L71) · [API prompt serialization](../apps/api/src/Http/AutomationsHandlers.ts#L72)

Use the apply fingerprint of the canonical resource kind and resolved body. Write the observed resource ID and source deployment's normalized base URL into the existing lock format. The no-op check compares the desired and live resource fingerprints. The exporter should validate that equality before offering the archive. [Canonical fingerprint](../apps/cli/src/Project/Resources.ts#L35) · [No-op and drift decisions](../apps/cli/src/Project/Plan.ts#L118) · [Base URL lock](../apps/cli/src/Commands/Apply.ts#L68) · [Dashboard deployment lookup](../apps/app/src/api.ts#L468)

## Candidate bundles

### Automation definition with literal references

```text
checkfu-lock.json
automations/
  daily-support-report--auto_fixture_support_report.yaml
```

```yaml
type: automation
name: Daily support report
description: null
agent: {type: agent, id: agent_fixture_support, version: 1}
environment_id: env_fixture_cloud
initial_events:
  - type: user.message
    content:
      - type: text
        text: Summarize the queue.
schedule:
  type: cron
  expression: '0 9 * * 1-5'
  timezone: UTC
```

```json
{
  "version": 1,
  "base_url": "http://localhost:1337",
  "resources": {
    "./automations/daily-support-report--auto_fixture_support_report.yaml": {
      "kind": "automation",
      "id": "auto_fixture_support_report",
      "hash": "f7dcb171c3d01ae23983d879bb15ed428eeb749180fc4038aac5c0bbfa201005"
    }
  }
}
```

The lock owns just the automation. Use a sanitized name stem and the full resource ID. Two resources named “Daily support report” can use suffixes `--auto_fixture_support_report` and `--auto_fixture_support_report_second` with distinct lock entries. The synthetic second automation binds `agent_fixture_other` at v2 and has hash `f5ba0134cf0a5a818208bc9b4b99fff7ffb3266754fd028c38866307557e0d60`.

### Automation with editable dependency definitions

```text
checkfu-lock.json
agents/
  support--agent_fixture_support.yaml
environments/
  cloud--env_fixture_cloud.yaml
automations/
  daily-support-report--auto_fixture_support_report.yaml
```

The agent file describes the current v3 head.

```yaml
type: agent
name: Support
model: fixture-model
description: null
system: Current head behavior.
mcp_servers: []
tools: []
```

The environment file describes its current configuration.

```yaml
type: environment
name: Cloud
description: null
config:
  type: cloud
  networking:
    type: unrestricted
```

Keep the same automation fields and use these two references.

```yaml
agent: {path: ../agents/support--agent_fixture_support.yaml, version: 1}
environment_id: ../environments/cloud--env_fixture_cloud.yaml
```

The lock retains the same version, base URL and automation entry. It adds entries for the current dependency definitions. Agent normalization omits empty tool and MCP server arrays from the fingerprint.

| Lock key | Kind | ID | Canonical fingerprint |
| --- | --- | --- | --- |
| `./agents/support--agent_fixture_support.yaml` | agent | `agent_fixture_support` | `97a7cf3a12f55bdb6bb012ed483c6304619f6014a29d8f49cb89a1409cf0863e` |
| `./environments/cloud--env_fixture_cloud.yaml` | environment | `env_fixture_cloud` | `b9ccbef955b42a5fb78aa85ef89ff49b25f3cae82cdf4c3b8249b26a7dc8bc77` |

The automation normalizes to the same v1 pin and hash. Apply leaves an unchanged v3 head alone. Putting v1's historical content in the editable agent source would propose restoring that content over the head. Another deployment has its own identities and version history. Even with local paths, v1 created there from a v3 definition would have different contents from the original v1. This bundle has the source deployment's lock and makes dependency edits part of its apply scope. [Authoring lock format](../packages/authoring/src/Lockfile.ts#L41) · [Existing agent project export](../packages/authoring/src/Document.ts#L107)

## Dry-run matrix

Ran the CLI entry point with the existing request-intercepting harness, a temporary project and synthetic API responses for the bundles above. The automation pinned v1 while the agent head was v3. Every HTTP request was a GET. The lock mismatch and missing local file made zero requests. The existing apply and apply-safety suites also passed all 29 tests. [CLI harness](../apps/cli/test/helpers/CliHarness.ts#L431) · [Apply tests](../apps/cli/test/Cli.apply.test.ts) · [Apply safety tests](../apps/cli/test/Cli.apply-safety.test.ts)

The fixture ran `checkfu apply --lock-file <bundle>/checkfu-lock.json --dry-run <bundle>` with its API URL selected. A blocked preview can exit zero. Actual apply checks for blocked rows before executing writes.

| Local or remote change | Observed preview | Reads recorded |
| --- | --- | --- |
| Literal v1, agent head v3 | Automation `unchanged` with its existing ID. | Automation detail only. |
| Literal v1, agent head edited to v4 | Automation `unchanged`. | Automation detail only. |
| Literal v1, pinned agent unavailable | Automation `unchanged` in the preview. Export needs its own dependency check. | Automation detail only. |
| Remote automation name edited | Automation `blocked`, with `name` shown as the difference. | Automation detail only. |
| Replace the reference with a bare agent ID | Automation `update` with an agent change from v1 to v3. | Automation detail and agent head. |
| Bare agent ID cannot resolve | Missing agent error. | Automation detail and agent head. |
| Bundle the current dependencies with an explicit v1 pin | Agent, environment and automation all `unchanged`. | Agent head, environment detail and automation detail. |
| Bundled agent definition edited locally | Agent `update` on `system`. The environment and the explicitly pinned automation stay `unchanged`. | Agent head, environment detail and automation detail. |
| Bundled agent head edited remotely | Agent `blocked` on `system`. The preview shows an automation `update` with an unresolved relative agent reference. Apply stops on the blocked dependency. | Agent head, environment detail and automation detail. |
| Bundled environment missing | Environment `blocked`. The preview shows an automation `update` with an unresolved relative environment reference. Apply stops on the blocked dependency. | Agent head, environment detail and automation detail. |
| Required local agent file missing | Local error naming the relative agent path. | None. |
| Two exports with the same display name | Distinct lock identities and two `unchanged` rows. | The two automation detail IDs. |
| Locked folder used against `http://localhost:7331` | Base URL error identifying the source deployment. | None. |

## Acceptance cases

- Export a saved automation pinned to v1 while its agent head is v3. Verify the YAML, canonical lock hash and one `unchanged` dry-run action. The preview issues only a GET of the automation.
- Check `GET /v1/agents/{agent_id}?version=1` and the saved environment during export. Verify the requested IDs, the exact agent version and `archived_at === null` on both resources. Cover both an unavailable resource and a 200 response for an archived resource. In either case, show the dependency identity and version where applicable and withhold the archive. The CLI's unchanged result checks the automation configuration. [Historical agent read](../packages/sdk/src/Api.ts#L1900) · [Automation admission](../packages/domain/src/Automation/AdmitAutomation.decision.ts#L49)
- Edit the automation remotely and verify the CLI shows the changed field and blocks an ordinary apply. Use another API URL and verify the rejection precedes HTTP requests.
- Round-trip two resources with identical names and match each deterministic file and lock entry to its own ID. For the editable bundle, exercise the same rule on agent and environment definitions before producing relative paths.
- Round-trip leading or trailing prompt whitespace, quotes, punctuation and multiline text through the YAML events. Verify the canonical fingerprint equals the saved configuration and the archive uses only the create fields and existing lock metadata.

## Decision

Start with the automation definition and literal references. It preserves the resolved configuration and gives an unchanged preview with one resource read on the original deployment. Check the exact agent revision and environment are available and unarchived before downloading. Reuse shared authoring normalization and the dashboard's existing archive flow. Verify the generated archive in the CLI harness before shipping the export.

Consider the editable dependency bundle for projects that intend to manage all three resources together. It introduces dependency drift decisions and leaves historical revisions on the source deployment. Keep apply's existing lock format and base URL behavior for either choice.
