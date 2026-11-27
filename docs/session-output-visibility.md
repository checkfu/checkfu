# Session output visibility

## Observable states

`GET /v1/sessions/{session_id}/outputs` returns the session's latest active output artifact. Its `id` and `version` identify what the dashboard can open. `file_count`, `total_bytes` and `files` describe that version. The `publication` field describes optional public sharing and can be null for an artifact the dashboard can open. The endpoint reads the committed artifact head directly, including a newer version added through the artifact API. When no active artifact is available, it returns 404 for either an existing session with no available outputs or a missing session. The dashboard already resolves the session on its detail route. [Outputs handler](../apps/api/src/Http/SessionsHandlers.ts#L1042) · [Artifact resource](../packages/sdk/src/Api.ts#L1117) · [Session detail route](../apps/app/src/routes/_app/sessions/%24sessionId.tsx)

| Situation | Known from the current API | Inference or unavailable fact | Dashboard treatment |
| --- | --- | --- | --- |
| No prior output | An independently loaded session exists and its outputs read returns 404. | The dashboard cannot tell whether no output was attempted, publication is running, or an artifact was removed. | Show “No outputs available” and no artifact link. |
| First publication | The outputs read returns 200 with the artifact ID, version 1, and its file metadata. | Version 1 is available. The producing turn is unavailable. | Show “View session outputs · v1” and link to that version. |
| Prior artifact during a new turn | The session can report its current status and turn. The outputs read can still return the prior version. | A running or recently settled turn suggests publication may still occur. The outputs endpoint has no pending status. | Keep the link to the last observed version while refreshing. |
| Publication refused | The positive ID and version can stay unchanged, or 404 can continue when there was no previous output. | Refusal and its reason are unavailable through this endpoint. An assistant refusal is a different fact and is itself an eligible stop reason for output capture. | Keep any available version. Show the empty state when a current read confirms 404. |
| Empty or identical directory | The same prior version can remain available, or 404 can continue. | The endpoint does not identify an empty capture or an unchanged manifest. | Keep the available prior version and avoid a turn label. |
| Superseded publication | A prior version remains observable, if one exists. | A rejected workspace fence can mean a later turn or an interruption. The endpoint exposes neither cause and cannot assign a version observed later to either turn. | Show the endpoint result and leave the transcript's turn state alone. |
| Publication timeout or storage failure | The session reply and completed turn can be visible while the output lookup is 404 or still shows the prior version. | Timeout, retry exhaustion, and subsequent recovery are unavailable. | Keep the available version. An error fetching outputs gets a retry state of its own. |
| Closed session | A known archived or terminated session can still have an active outputs artifact. | Closing the workspace does not indicate whether its last turn published. | Keep the same read-only navigation for available outputs. |

The creation fixture publishes two files, then retrieves the same artifact by its returned ID and reads both file bodies from version 1. Its response contains `publication: null`. The version-advance fixture changes file contents and sees a new committed head through the outputs endpoint even without a version projection. The limit and read-failure fixtures retain the last complete version after a later refusal. The empty-directory fixture compares the full prior artifact response with the response after it removes the last output. [Output integration cases](../apps/api/test/Api.outputs.test.ts#L243) · [Limit refusal](../apps/api/test/Api.outputs.test.ts#L474) · [Prior version after a failed read](../apps/api/test/Api.outputs.test.ts#L679) · [Committed head](../apps/api/test/Api.outputs.test.ts#L853) · [Empty capture](../apps/api/test/Api.outputs.test.ts#L929)

The timeout fixture proves the reply can settle while publication stalls. It initially sees 404. A later eligible turn writes nothing and can still publish the files left in the workspace. The supersession case similarly lets a later capture include earlier files. A publication result can truthfully identify the turn that captured a version. File authorship remains unknown. [Timeout and later recovery](../apps/api/test/Api.outputs.test.ts#L1057) · [Supersession](../apps/api/test/Api.outputs.test.ts#L1097)

## Navigation

Place an **Outputs** row beside the session bindings. Use one optional query keyed by session ID and enabled once the session is loaded. The session and transcript can render while the output lookup runs. Use the existing artifact route and its positive `version` search parameter. A target such as `/artifacts/art_example?version=1` stays at that version even if the session later observes version 2. The artifact page has its own version selector. A historical version can return a retryable 503 while its projection catches up. Retry the same versioned URL so the destination stays pinned. [Session detail](../apps/app/src/pages/sessions.tsx#L415) · [Artifact route](../apps/app/src/routes/_app/artifacts/%24artifactId.tsx) · [Version search](../apps/app/src/artifact-view.ts#L55) · [Version lookup](../apps/api/src/Http/ArtifactsHandlers.ts#L314)

| View state | Example and interaction |
| --- | --- |
| Initial request | “Loading outputs…” appears in the row. Keep the transcript usable and leave focus in place. |
| Available | A normal link reads “View session outputs · v1”. The visible label and destination use the same response. A positive version pins the link. If the resource has version 0, only offer its unpinned artifact detail. |
| Refetch | Leave the last known link in place. If the fresh response advances the version, update its text and link together without replacing the focused element. A user already on the artifact detail stays on the version they opened. |
| Known-session 404 | Show “No outputs available”. Clear an earlier link on a confirmed current 404. A missing or inaccessible session is handled by the session route or sign-in flow. |
| Transient error | Show “Could not refresh outputs” with a Retry button. If a previously verified result is still cached in the current signed-in session, keep the versioned link and identify it as the last checked version. |
| Archived or terminated | Keep the same outputs row and a working link when the artifact is available. Remove the row's loading state when the current request settles. |

Refetch on entry, browser focus or reconnect, and after the existing debounced session snapshot refresh for an eligible settled turn. One output read can race publication because the turn commits first. Keep a “Refresh outputs” action available so the user can ask for a later snapshot. A new response replaces an older version only for the current request generation. Ignore a stale response from an earlier refresh or session. Handle a 401 with the dashboard's existing sign-in flow and clear cached outputs on sign-out. The first release can use these refresh paths without transcript-triggered polling. [Session event refresh](../apps/app/src/pages/use-session-events.ts) · [Sign-out cache handling](../apps/app/src/pages/layout.tsx#L24)

The link and refresh action participate in the normal keyboard tab order. Refresh preserves focus. Opening a version uses ordinary route navigation, and going back restores the session context. Use a concise polite status announcement for a visible availability change and avoid repeated announcements for unchanged background results. When a focused link is removed after a definitive 404, keep the user in the same section by focusing its refresh action.

## Turn attribution

If per-turn visibility becomes necessary, record an outcome when publication actually runs. The domain policy asks for capture after an idle event with `end_turn`, `budget_reached` or `refusal`. Other stop reasons and the separate workspace-discard action have their own semantics. An idle event or successful reply alone cannot establish that outputs are published, empty or refused. [Publication policy](../packages/domain/src/Session/PublishSessionOutputs.policy.ts) · [Publisher](../apps/api/src/Artifacts/SessionOutputsLive.ts)

Use a typed record keyed by `session_id` and `turn`. Record transitions as domain facts and project the current outcome for reads. An eligible attempt can move from pending to one of these outcomes.

| Outcome | Authoritative evidence |
| --- | --- |
| Published | The exact artifact commit receipt ties this turn's operation to an artifact ID and positive version. |
| Unchanged | The owner verifies the captured manifest equals the active head in the serialized terminal write. Carry the matching artifact ID and version. |
| Empty | A typed workspace capture proves the requested turn owned a live workspace, listed it successfully, and found zero files. |
| Refused | Output validation declined the listing or sealed manifest. Keep a coarse reason such as size limit or invalid output. |
| Superseded | A typed fence rejection confirms that a later turn owns the workspace. |
| Timed out | The publish budget expired and the operation is known to have no commit. An ambiguous commit remains pending while reconciliation runs. |
| Failed | Publication exhausts its retries with a non-timeout failure. Use a bounded public reason. |
| Unavailable | The publisher confirms that the workspace was discarded, the requested turn was interrupted, or the artifact was deleted. |

The workspace must distinguish a successful empty capture from a discarded workspace. The current list and read adapters can answer with empty results after discard. The current fence can also reject an interrupted request for the same turn. Require typed evidence of workspace ownership and fence rejection before showing empty or superseded. If the attempt lacks that evidence, expose unavailable when the cause is known and otherwise leave the result unknown. [Workspace adapters](../apps/api/src/Workspace/SessionWorkspace.do.ts#L499) · [Turn fence](../apps/api/src/Workspace/WorkspaceFence.ts#L22)

Use the existing turn-specific artifact command identity `outputs:{session_id}:{turn}` for a durable operation at the artifact owner. Register the attempt before staging files. The owner supplies a generation for that operation and a read-only lookup of its pending or terminal result. Resending a command can execute a new mutation when its receipt is absent, so use the lookup for recovery. The version commit checks the operation's active generation and records the committed ID and version in the same serialized write. Every non-publishing terminal outcome closes the same generation at the owner before projection. If the commit already won, closure returns the committed version. If closure wins, it prevents a delayed commit from that generation. A poll that still cannot establish the owner result leaves the operation pending. Project the owner result to the session. [Current artifact writes and command identity](../apps/api/src/Artifacts/SessionOutputsLive.ts#L133)

A replay reads the recorded outcome before capture and keeps the original version if the head has advanced. A future adoption of terminal unchanged outcomes would deliberately change one current behavior. An unchanged capture can now replay after a manual edit and republish the workspace over that edit. With a terminal unchanged outcome, a replay keeps the old outcome and a new eligible capture can publish over the newer head. The session-level navigation works with today's behavior while turn outcomes are deferred. [Replay after a manual version](../apps/api/test/Api.outputs.test.ts#L1182)

Expose any future outcome with session-level authorization and the same artifact access checks when opening a version. Keep paths, file names, hashes, stack traces and raw validation text out of the outcome. A bounded retention window can keep the most recent 100 eligible turns per session, with archived sessions following the same rule. Retain owner receipts until the projection is acknowledged. After a result is pruned, keep an owner-side turn cutoff that rejects delayed replay. Advance the cutoff only after earlier attempts are resolved or fenced. Finalize the retention and deletion contract alongside the durable design. An absent or expired result is unknown. Deleting an artifact removes navigation to it even if an outcome still records that a version was once captured.

## Acceptance cases

| Exercise | Session-level experience | Separate per-turn acceptance if implemented |
| --- | --- | --- |
| Start a session with no active artifact | Known-session 404 shows “No outputs available”. No placeholder link. | An eligible empty capture has an explicit empty result. A session that never requested capture has no result. |
| Publish version 1, then publish version 2 | Refresh updates the row from v1 to v2. Both version URLs resolve to their actual contents. If v1 returns a projection-related 503 after v2 commits, retry v1 at the same URL. A browser already on v1 stays there. | Each committed capture reports its own version even after later refreshes. |
| Refuse a new output after an earlier publication | The previous version remains openable. The transcript and row avoid a label about what the later turn published. | Verify a refused outcome with a coarse reason. No new version is attributed to the refused capture. |
| Let a publication time out | Keep a prior available version or show the empty state after 404. The model reply still appears. | Mark timed out only after ruling out the commit. Exercise a stall, a late receipt and a successful later capture. |
| Supersede a turn during capture | Show the latest available artifact and keep its versioned navigation. | Verify the originally attempted turn is superseded and the later successful capture gets its own outcome. |
| Refresh while already viewing an older valid version | Keep the session row usable while loading. Its new versioned link reflects a fresh 200, while the existing artifact view stays pinned. | The old outcome keeps its original version and relevant timestamp. |
| Reopen, navigate by keyboard, or hit a transient error | Repeated opens stay at the displayed version, refresh is keyboard accessible, and Retry preserves focus. A 401 clears access and a confirmed 404 removes the cached link. | Reading or reopening never runs publication again. |
| Archive while capture is completing | The archived session remains able to open an available final artifact. | Verify the existing publication-before-workspace-discard ordering. Replay an unresolved request after discard and verify its workspace result is unavailable. |
| Interrupt the same turn during capture | Keep any readable output at its observed version. | Verify that an interrupted same-turn fence is distinguishable from a later-turn fence. |
| Replay or reorder publication and closure | Reopening the artifact has no effect on the publisher. | For each non-publishing terminal outcome, verify commit-first returns the same committed version and close-first prevents a late commit. Duplicate work after retention is fenced. |
| Add a manual version after an unchanged capture | The link follows the observed head, including the manual version. | Under the future terminal outcome contract, replay cannot overwrite the manual version. A new eligible turn can capture against that head. |

## Decision

Ship the session-level link first when implementing the UI. It gives users a place to find existing deliverables using the current outputs read and the versioned artifact page. The work is confined to dashboard data loading, navigation and accessibility. The current outputs integration cases provide the expected behavior for refusal, timeout, supersession, and retained versions.

Defer turn outcomes until users need to identify which capture published a version or distinguish an empty capture from a failed one. That work needs durable transitions, receipt reconciliation, authorization and a retention decision. Its acceptance can pass independently of the session link, and it must preserve the distinction between capturing a version and authoring its files.
