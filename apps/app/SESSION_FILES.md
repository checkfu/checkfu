# Saved session files

Saved files belong on the session detail page, including after archive. Use a compact Files section beside the mounted resources. The list represents files saved from the session workspace by the service. It does not list mounts, artifact versions, or arbitrary workspace paths.

## States

| API result | Dashboard |
| --- | --- |
| `none` | Show “No files saved yet.” |
| `saved` | Show the recorded turn, time, and each available file’s name and size. Show the per-file skip notices alongside the available files. |
| `saved` with zero available files | Show “No saved files are available.” The service omits File owners that no longer have ready content. |
| `skipped` | Show the recorded turn and reason. If earlier files are still available, label them “Previously saved files.” The response does not name the earlier capture turn. Each File has its own origin turn and workspace path, and unchanged Files can be reused by later captures. |
| Loading or output lookup failure | Keep the transcript usable. Use a local loading state and a retry control. Preserve the last successful list while refreshing. |
| Download check or failure | Keep the row and link context visible. Report a missing file and refresh the list on 404. A temporary failure during the availability check offers a retry. |

## Data sources

Read `GET /v1/sessions/{session_id}/outputs` using a session-scoped query. The output capture policy runs after a turn settles with `end_turn`, `budget_reached`, or `refusal`. Refresh after those events and after stream recovery. Because the capture writes asynchronously, use bounded rechecks while the response turn is behind the captured turn. A pause or interrupt alone does not imply a capture. The recorded turn remains useful even when a capture is skipped.

Read bytes through the dashboard’s authenticated same-origin `GET /v1/files/{file_id}/content`. The Worker translates the session cookie into upstream authorization and forwards the attachment response. Check availability with a same-origin HEAD request before starting a browser download. Let the browser stream the GET to its download manager. HEAD checks the File record. The browser owns transfer progress and errors that arise after the check. Use the response filename so the browser handles international filenames. The address carries only the File ID.

## Acceptance

- Finish a turn that writes a known byte sequence and a non-ASCII filename under the output mount. The Files section shows the recorded turn and name, and the browser receives the exact bytes and attachment filename from the same-origin endpoint.
- Skip a later capture. The panel explains the reason and continues showing earlier Files with their own names and sizes.
- Archive the session, reopen its dashboard, and verify the same File remains downloadable without an active workspace.
- Delete a File after the dashboard has listed it. The next download check reports it as unavailable, and refreshing the list leaves the transcript and other Files intact.
- Use the same File address in a signed-out browser. The dashboard forwards the request without authorization and the Files API returns 401.

Publication, signed visitor URLs, and inline preview use separate authorization and remain outside this view.
