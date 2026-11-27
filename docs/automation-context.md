# Automation session context

## What runs receive today

An automation stores an agent, an environment, a schedule and one initial
message. `CreateAutomationBody` in `packages/sdk/src/Api.ts` has no vault or
resource fields. `StartAutomationRunLive` in
`packages/domain/src/Automation/StartAutomationRun.policy.ts` opens the
session with those saved values. The existing `OpenAutomationSession` in
`packages/domain/src/Automation/OpenAutomationSession.command.ts` accepts
credential bindings and resources, with an empty resource list by default.

Consequently a scheduled session cannot authenticate an MCP server with a
vault credential, load a skill, share a memory store between runs or mount
a repository. For a manually opened session, `credentialsFor` and
`requestedResource` in `apps/api/src/Http/SessionsHandlers.ts` supply
those inputs. The test “gives a run's session no resources even when a
memory store exists” in `apps/api/test/Api.automations.test.ts` records
the current behavior.

## What an automation declares

- Add optional `vault_ids` with the same identity and count limits as
  `CreateSessionBody` in `packages/sdk/src/Api.ts`. The owner authorizes
  vaults. The run resolves credential IDs for the pinned agent's server URLs.
- Add `resources` reusing `MemoryStoreParams`, `ArtifactMountParams` and
  `SkillMountParams` in `packages/sdk/src/Api.ts`.
  Results show the saved references and concrete versions. Existing session
  mount validation supplies count and path collision rules through
  `SessionResources` in `packages/domain/src/Session/SessionResource.ts`.
- Exclude repository mounts from the initial contract. `GitHubRepositoryParams`
  in `packages/sdk/src/Api.ts` carries an owner-supplied token. Repository
  automation needs a vault credential type that can issue short-lived,
  repository-scoped credentials at run time.

Omitting either field on update keeps its saved value. An empty list clears
it. Keep the revision guard in `UpdateAutomationDecision` in
`packages/domain/src/Automation/UpdateAutomation.decision.ts`. A context
edit advances the saved definition revision and leaves the schedule armed
for the same firings.

## When references resolve

Validate references on create and on a context edit. Pin a concrete artifact
version and its immutable manifest for each artifact or skill. For a skill,
validate its root document and save its name and description with the pin.
`artifactVersion` and `skillOf` in `apps/api/src/Http/SessionsHandlers.ts`
establish these inputs today. Future versions take effect through an
explicit update. Verify the pinned version and active artifact at
admission.

Keep memory store and vault identities. Read current memory store metadata and
state at admission. Resolve vault bindings against the exact pinned agent
revision, current environment networking and active credentials at admission.
`credentialsFor` in `apps/api/src/Http/SessionsHandlers.ts` already obtains
that server list, and `CredentialUrlClaim` in
`packages/domain/src/Vault/CredentialUrlClaim.aggregate.ts` owns the mapping
from vault and server URL to credential.

If a declared dependency is gone or archived, or a previously configured
binding has no unique eligible credential, fail the run before creating its
session and pause that automation revision. A replacement credential for the
same vault and URL remains eligible. A server that has never needed a binding
can keep running anonymously. Saving the context needs to preserve which
server names require a binding, without saving any credential ID or secret.
Recompute that requirement when the agent pin or selected vaults change.
A server can keep its name while its URL changes.
Temporary storage or projection failures leave the attempt retryable.
`StartAutomationRunLive` in
`packages/domain/src/Automation/StartAutomationRun.policy.ts` already
separates permanent dependency failures from a session ID conflict and
passes the firing revision to `RecordAutomationRunFailed`.

## Where resolution runs

**Resolve ownership in the domain at admission.** Extend the
`OpenAutomationSessionDecision` pattern in
`packages/domain/src/Automation/OpenAutomationSession.decision.ts`. A
decision's `reads` declares aggregate types and `keyOf` maps the command
to IDs, including arrays for several instances. The installed Alchemy
`Decision.KeysOf` and its decision guide describe this contract. All IDs
must come from the command before the decision reads. Take the definition
from the `AutomationView` state attached to the `AutomationFired` policy
delivery. The raw event carries run identity and schedule information.
Keep the fired definition for retries and record its revision as admission
provenance. Later edits to the automation have their own revision and
affect later firings. The decision reads the active dependencies and
creates the session atomically against the captured definition. Use a
dedicated context admission decision for automation firings, including
Run now. Manually opened
sessions with one initial message also use the existing
`OpenAutomationSessionDecision` through the handler in
`apps/api/src/Http/SessionsHandlers.ts`.

The memory and artifact aggregates are already hosted by `Checkfu` in
`packages/domain/src/Checkfu.model.ts`. Vault, credential and URL claim
aggregates are hosted by `Vaults` in `packages/domain/src/Vaults.model.ts`
and wired as a separate runtime in `apps/api/src/ApiWorker.ts`. An Alchemy
decision reads only the aggregate instances hosted by its model. Before
adding vault context, compose the authoritative vault streams into the
same hosted model as scheduled admission and check stream routing,
storage placement and proof size. Keep a single owner for custody and
credential claims. A storage deployment or external call that only
returns a snapshot cannot supply the atomic read set.

For vaults, enumerate every declared vault and server URL pair, including
empty claims, and include candidate credential IDs. The decision checks
that it received the complete claim set, that selected credentials are
active and held by their vaults, and that each required binding resolves
uniquely. A credential with custody `storing` can acquire a claim before
its secret is ready. Treat that as retryable and wait within the run's
admission deadline. If a claim points to an ID outside the candidate read
set, resolve the keys again within the same deadline. Read secrets when
making the MCP request through `makeSessionMcp` in
`apps/api/src/Pi/PiMcpSession.ts` and `makeVaultMcp` in
`apps/api/src/Connection/VaultMcp.ts`. Keep its target and custody
checks. `makeVaultConnection` in the same module drops cached clients
on erase and seal so later revocation takes effect.

Use stable command IDs derived from the firing for successful session
admission and for recording the run outcome. Candidate rediscovery can
change how many commands a policy sends. Policy send order alone cannot
identify a retry. Keep the fixed Agent key in the decision read set so
changing candidate keys leaves the transaction primary stable. Recognize
an already committed session by its firing identity before taking a fresh
dependency decision on redelivery.

**Resolve stable bytes when saving the definition.** Use the existing
artifact and skill readers in `apps/api/src/Http/SessionsHandlers.ts` to
prepare immutable pins, and commit those with the saved context. A
save-time snapshot of current credential IDs would miss rotation and
claim changes. Store bounded canonical reference text where a proved
aggregate needs to carry a list, following `McpServersText` in
`packages/domain/src/Mcp/McpServers.ts`. The automation's definition and
its history belong in events and the view, following `AutomationView` in
`packages/domain/src/Automation/AutomationView.view.ts`.

**Reserve external work for storage I/O.** Running all of
`requestedResource` or `credentialsFor` as an external call would leave
a gap between validation and session commit. The save path can check
immutable artifact bytes through storage. The decision checks mutable
domain ownership and carries the exact approved references into
`SessionCreated`. Use the version of the automation view attached to
`AutomationFired` on retries, so later edits cannot silently change the
context of an accepted run.

## Unattended tool calls

`mcpPermission` and `gateDecision` in `apps/api/src/Pi/PiActions.ts`
honor a tool marked `always_allow` and refuse a tool that needs human
confirmation in an automation session. Credential resolution only authenticates the server.
Owners must explicitly allow each required tool on the pinned agent
version. A refusal lets the model continue without the tool and report
what it could not do. Custom tools that depend on an outside caller to
supply a result are also refused for unattended turns.

## Surfaces

- API and SDK. Extend the automation create, update and read schemas in
  `packages/sdk/src/Api.ts` with the shared resource references and vault
  identities. Reuse the session resolution errors where their meaning
  applies.
- Project files. Extend `desiredBody` and `remoteBody` in
  `apps/cli/src/Project/Resources.ts` so the configuration fingerprint
  includes context and pins. Resolve omitted artifact versions like bare
  agent references in `pinAutomationAgent` before computing the fingerprint.
  Preserve the revision checks and the distinction between keeping and
  clearing context.
- Dashboard. Extend the form in `apps/app/src/pages/automations.tsx` with
  bounded selectors for supported context. Show the saved pin and mount
  access. Use the same update path as the existing editor.
- MCP. Regenerate the tool schemas from the API through
  `tools/forge/src/McpTransformer.ts`. Accept identities and references
  through the same fields as the SDK.
- Export. Extend [Automation project export](automation-project-export.md)
  to preserve identities and saved versions with the original deployment's
  lock. Include references in the drift check. Export carries no secret
  material.

## Verification

Add admission rules that each successful run mounts exactly the stores
declared for its revision, and each attached credential comes from a
declared active vault for the exact server URL. Prove that context refusal
records no session, that a stale run cannot pause a newer revision and
that retry cannot attach a different context to an already opened session.
Check the decision's native read-set size at the maximum supported
cardinality. Symbolic search explores a smaller array envelope, so
review the explored bound for each rule before claiming coverage.
Extend the `AutomationRuns` verification model to host context
dependencies and definition updates. Add a story that redelivers the
opening after session commit, before run recording, with changed
claims and a newer definition. Re-run `AutomationRuns.verify.test.ts`,
`Checkfu.verify.test.ts` and the affected memory, vault, artifact and
session suites in `packages/domain/test`.

Exercise two runs of the same automation. The first writes an entry to its
declared store. The second reads that entry, and an automation with a
different store cannot read it. Archive the store between firings and
check that the next run fails before session creation. Add a vault story
in which the same URL gains a new credential, and a concurrent claim
change between preparation and admission. Exercise the published HTTP
payloads along with the native storage and callback paths.

## Build order

1. Carry memory store references and access through automation events and
   session admission. Land the two-run memory test with the first usable
   slice.
2. Add the bounded immutable artifact and skill preparation, including
   explicit version pins and archived-dependency handling.
3. Co-host the authoritative vault and admission streams, then add vault
   allowlists. Verify claim selection, revocation and unattended tools
   against that hosted model.
4. Expose each admitted context kind in the dashboard and project
   surfaces with an export/apply round trip.

## Decision

Reuse session reference shapes, pin immutable artifacts and skills when
saving, and resolve mutable ownership at run admission. Start with memory
stores to verify durable context and revision fencing before adding
credentials. Decide separately whether repository automation needs an
installation-level credential and whether schedule owners should receive
a notification when a context dependency pauses a run.
