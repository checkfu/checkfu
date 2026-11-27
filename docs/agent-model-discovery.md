# Discover models when creating an agent

The agent form accepts a model ID. Agent creation and edits that change the model validate that ID against the API Worker's deployment catalog. The harness resolves the saved ID again on the first turn and checks the credentials it needs to execute. A valid model can still fail to start when those credentials are missing. [Agent handlers](../apps/api/src/Http/AgentsHandlers.ts) · [Harness resolver](../apps/api/src/Pi/PiDurableHarness.ts) · [Execution check](../apps/api/src/Pi/PiDurableEngine.ts)

## Data contract

Use one authenticated `GET /v1/models` read for suggestions. Use the same deployment authentication as agent creation and the dashboard's existing authenticated API proxy. A missing or invalid caller credential returns 401 on a deployment with API authentication configured. The shared middleware returns 503 when the deployment key is missing. Both responses exclude catalog data.

```json
{
  "data": [
    { "type": "model", "id": "lab/report-v2" },
    { "type": "model", "id": "studio/report-v2" }
  ],
  "next_page": null
}
```

| Field | Source |
| --- | --- |
| `data[].type` | API resource discriminator with the literal value `model`. |
| `data[].id` | A model specifier validated by `resolveCatalogModel`, using the same minimum context window as agent creation. Starts with a provider ID followed by the model ID. |
| `next_page` | The API's existing list envelope and opaque cursor convention. The cursor binds the search and ordering to this result set. |

Seed suggestions from the built-in provider defaults and the deployment's configured custom default and declared model IDs. Filter each through the same resolver as authoring. Reject candidates that fail its input or context-window rules. Deduplicate on the provider-qualified ID. An unqualified built-in alias follows the existing resolver's first eligible catalog match. Two custom providers can both expose `report-v2` and each receives its own qualified suggestion. Qualified unlisted IDs may still resolve, so manual entry stays available regardless of the returned list. [Provider defaults and alias resolution](../packages/pi-providers/src/Catalog.ts) · [Model rules](../packages/pi-providers/src/ModelResolution.ts) · [Deployment validation catalog](../apps/api/src/Pi/PiCatalog.ts)

Return IDs in ascending order and a bounded default page of 20. Accept optional search text over the IDs along with the existing `limit` and opaque `page` convention. List only the typed fields above. Provider URLs, headers, credentials, environment variable names, routing rules, and execution readiness have no response fields. The API can reuse its deployment-local validation projection without contacting any provider. Apply private no-store HTTP caching and keep any short-lived dashboard cache scoped to the API origin and signed-in session. Clear that cache on sign-out or a deployment change.

## Dashboard states

| State | Behavior |
| --- | --- |
| Opening or typing | Keep the editable model field and show suggestions when they arrive. Discard late responses for earlier searches. Arrow keys move within the list, Enter selects the focused result, Escape closes it, and the typed value remains editable. |
| No matches or no suggestions | Keep manual entry. A result set may contain only a subset of deployment-valid IDs. Existing save validation handles a submitted ID. |
| Read failure | Leave the input usable and offer Retry. A catalog read failure does not prevent submitting a typed ID. |
| Editing an existing agent | Show its saved model even when the catalog no longer suggests or accepts it. Preserve it on edits to unrelated fields under the current update contract. Validate an explicitly chosen replacement at save. |
| Missing execution credentials | A selection can still be valid. The first turn reports the existing execution failure if credentials are missing. |

## Acceptance cases

- Authenticate and retrieve a default model. Saving that returned ID succeeds and produces a model reference with the same ID.
- Configure a custom default and two custom providers declaring the same short name. Both valid qualified suggestions appear. Cover an eligible unqualified built-in alias that resolves according to existing precedence. Test candidate filtering with a synthetic resolver input below the context threshold. Separately assert the deployment parser rejects a custom manifest below that threshold.
- Keep manual submission for valid qualified IDs absent from the suggestions. An unsupported manual ID follows the current save error path.
- Verify the 401 contains no catalog data. With authentication, compare response keys against the allowlist and verify custom URLs, headers, credentials, and readiness details are absent. Assert provider request count stays zero.
- List a resolver-valid model with a synthetic deployment whose execution credentials are absent. Saving succeeds and a first turn exercises the separate missing-credential outcome.
- Remove a custom provider and verify its previously saved model ID no longer resolves. Load the saved agent, edit the description, and verify the update request omits the model field. Confirm selecting a valid replacement updates it. Exercise empty, failed, and slow lookup, keyboard selection, pagination, and sign-out during a request.

## Decision

Ship authenticated suggestions with manual entry. Start with a typed projection beside the API's catalog resolver and test it against the same model validation used on writes. Add the read route to the API contract and regenerate its client surfaces. Then add the dashboard query and accessible selector. Sending the full provider catalog to the browser would expose unnecessary deployment details and duplicate validation across runtimes.

Compare successful agent saves and unsupported-model validation errors before and after the feature using aggregate counts. Keep credential readiness as separate work with explicit authorization and a dedicated source of truth. [Deployment Worker bindings](../apps/api/src/Pi/PiCatalog.ts)
