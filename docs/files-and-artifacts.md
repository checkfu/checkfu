# Files and artifacts: the domain

Status: steps 1 to 4 are built (files, files as session inputs, outputs saved as files, artifact versions from files); the rest is planned. Nothing is deployed and there are no users, so this describes the end state with no compatibility or migration steps.

## The problem

Before this work one concept, the artifact, did four jobs:

1. **Input.** A session mounts an artifact version to read files.
2. **Skill.** A skill is an artifact that happens to hold a `SKILL.md`.
3. **Output.** A session's outputs folder becomes versions of an artifact with a derived id.
4. **Deliverable.** An artifact can be viewed by link or published at an address.

Each job pulls the artifact a different way, and the seams show:

- Giving an agent one PDF takes three calls and leaves a named, versioned, publishable thing behind.
- A message cannot carry a file, because there is no single-file id to refer to.
- An output over a limit lost the whole turn's outputs, and no one could see why: the outputs endpoint answered the same way for a turn that wrote nothing, a save still running, a refusal and a failure.
- A client can add versions to, publish or delete a session's outputs artifact, so the publisher needs rules for each.
- Nothing lists skills or checks one when it is uploaded.
- An artifact needs an empty state (version 0) and a blob upload route only so that large files have somewhere to go.

## The concepts

| Concept | One sentence | Changes? | Has versions? | Who makes it |
|---|---|---|---|---|
| **File** | One piece of content with a name. | Never | No | A client uploads it, or a session produces it |
| **Artifact** | A named deliverable made of files, which can be viewed by link or published at an address. | By adding versions | Yes | A client, from files |
| **Skill** | A folder of instructions an agent loads. | By adding versions | Yes | A client, from files |
| **Workspace** | A session's private working disk. | Freely | No | The session; discarded when it ends |
| **Memory** | Unchanged by this design. | | | |

Words that stay internal: *blob* (bytes stored under a sha256) and *manifest* (a version's list of paths). *Publish* means one thing only: giving an artifact a public address. Outputs are *saved*, not published.

How they relate:

```
client ──upload──▶ File ──mounted read-only──▶ Session workspace ──outputs folder──▶ File (origin: session, turn, path)
                    │                                                                  │
                    └──────────────── named in a version ──▶ Artifact ◀────────────────┘
                                                              │
                                                    viewing link · published address
```

- A session reads Files and produces Files.
- An artifact version is built from Files. The artifact keeps its own copy of the bytes, so deleting a File never breaks an artifact.
- A session can also mount an artifact version as a read-only folder, to continue work on a deliverable.

## File

**State:** `status` (none, ready, deleted), `filename`, `content_type`, `size`, `sha256`, `origin` (uploaded, or the session, turn and path that produced it), reservation counters, `created_at`.

**Commands and events**

| Command | Event | Notes |
|---|---|---|
| `ReserveFile` | `file.reserved` | Before any bytes are written. Same pattern as artifacts. |
| `CreateFile` | `file.created` | After the bytes are stored; records size and sha256. |
| `ExpireFileReservation` | `file.reservation_expired` | Scheduled; never rejects. |
| `DeleteFile` | `file.deleted` | |

**Policies:** `ExpireFileReservations` schedules the expiry. `ReleaseFileBytes` purges the bytes after a delete or a lapsed reservation.

**Rules proved**

- A file is described (filename, size, sha256) exactly when it has been created.
- Filename, content type, size, sha256 and origin never change once created.
- An origin names a session, a turn and a path together, or none of them.
- A deleted file stays deleted.
- Creating takes the open reservation; only the latest reservation is open.

**Bytes:** one object per file at `files/<scope>/<file_id>/content`. One owner object per file is the single writer: it takes one content write at a time, refuses a write from a reservation older than one it has seen, and waits for a write in flight before a purge or a release. The upload streams through it, and the sha256 is computed as the bytes arrive. The rules it keeps live in `apps/api/src/Files/ByteOwner.ts`. The artifact owner keeps the same rules in its own module for now; moving it onto this one is a separate change with no visible effect.

**Upload:** the request body is the file's bytes, with `filename` and an optional `content_type` in the query, and a `Content-Length`. The content type defaults to the one the filename's extension implies. With an `Idempotency-Key`, a retry answers with the same file, and the same key with a different name, type or bytes is refused.

**API**

| Route | Purpose |
|---|---|
| `POST /v1/files` | Upload one file. Returns the file. |
| `GET /v1/files` | List in creation order. A `session_id` filter for everything a session ever saved can follow. |
| `GET /v1/files/{file_id}` | Metadata. |
| `GET /v1/files/{file_id}/content` | Raw bytes. |
| `DELETE /v1/files/{file_id}` | Delete. |

CLI: `checkfu files upload <path>`, `list`, `retrieve`, `download --file-id <id>`, `delete`. One file per command, mapped one to one onto the routes.

## Sessions and files

**Input.** A session resource `{type: "file", file_id, mount_path?}` places the file read-only at `/mnt/session/uploads/<mount_path>`, defaulting to its filename. Creating the session refuses a file that is missing or deleted, a path taken twice or inside another, and more than 32 files. The resource records the file's size and sha256, and the agent is told each path and size.

The file is read from file storage in ranges as the agent reads it, through the same read-only mount that serves artifact files. A file deleted after the session started stops being readable; the session's turns carry on.

Two things this does not do yet:

- **Reading from a shell.** The uploads directory is served to the agent's file tools. A session that runs commands on a machine needs the files copied into it, which is a separate change for every read-only mount.
- **A proved admission rule.** Whether the files exist is checked when the session is created, as it is for artifacts. A decision reads a fixed set of aggregates, so it cannot read a list of files.

**Output.** After each turn that ends with a reply, a policy saves the outputs folder:

1. List `/mnt/session/outputs` inside the turn fence. A file over a limit, one that changed while it was read, or one that is not a regular file is skipped on its own and named with the reason. Only a folder that cannot be read as one, or that holds more files than a record can name, skips the whole turn.
2. For each file, derive its file id from the session, the path and the content's sha256. If that file already exists it is reused, so unchanged content is never stored twice and a replay creates nothing. Otherwise the bytes are read and a File is created with origin `{session_id, turn, path}`.
3. Record the turn on the session's outputs record, `SessionOutputs`: either `session_outputs.saved {turn, files, skipped}`, where `files` is the folder as that turn left it, or `session_outputs.skipped {turn, reason}`, which keeps the files of the last turn that saved.

`GET /v1/sessions/{session_id}/outputs` answers from that record: the latest recorded turn, whether it was saved or skipped and why, the files, and the files that were skipped. A file the client has since deleted is left out. Every saved file is also an ordinary file under `/v1/files`.

The record is its own aggregate, keyed by the session. Its lists travel as bounded text, as an agent's tools and servers do, so every rule about it is proved rather than checked on small lists.

**Rules proved**

- A turn is recorded at most once, and the recorded turn never goes back.
- A saved turn replaces the files; a skipped turn keeps the files saved before.
- A reason is given exactly when the turn was skipped.

The record is written only by the save, and a file's id carries its session. The endpoint also leaves out any file whose origin is another session.

Three consequences worth knowing:

- **A deleted output stays deleted.** If a client deletes a saved file and the same content is still at that path, later turns list the path under skipped with that reason instead of saving it again. Changed content at the path is saved as usual.
- **A skipped turn can leave files behind.** A save that fails or times out partway has already created some files. They are ordinary files with that turn as their origin, the record does not name them, and the next save reuses them.
- **Skips are never dropped.** If more outputs are skipped than a record can name, the turn is skipped with the count instead.

**Later, on the same foundation:** adding and removing file resources on a running session, and `image` and `document` blocks in a user message that name a `file_id`.

## Artifact

An artifact keeps one job: a deliverable with versions that can be viewed and published.

- **A version is built from files.** Each entry is `{path, file_id}`, `{path, content}` for small text, or `{path, sha256}` to keep a file of the version being replaced. For a `file_id`, the artifact copies the bytes into its own storage, checking them against the file's sha256 as they pass, so deleting the file later never changes a version. The reservation is recorded with the owner before any bytes are copied, so the cleanup of an older, lapsed attempt cannot remove them.
- **No empty artifacts.** `OpenArtifact`, version 0 and the blob upload route are gone. The rule "an artifact exists exactly when it has a version" is back in its strong form, and proved.
- **Viewing links, publication, pinning a version or following the latest:** unchanged.
- **Session mount:** `{type: "artifact", artifact_id, version?}` stays, as the way to hand a session an existing deliverable to work on.

Turning a session's outputs into something shareable is one explicit call: create an artifact, or a new version, naming the output files.

**The agent can do it itself.** The `save_artifact` tool takes a name and a directory of the workspace. Each file under the directory is saved as a file of the session, and the artifact is created from those files, or given a new version if the session already saved one under that name. The artifact's id is derived from the session and the name, and a file's id from its content, so calling the tool again with nothing changed does nothing, and a repeated call after a crash cannot create a second artifact. An artifact made this way can only be built from files that session saved. The tool takes up to 256 files, 8 MiB each and 64 MiB in total; larger deliverables go through `POST /v1/files` and `POST /v1/artifacts`. Sizes are checked before anything is saved. If the turn is interrupted while a save is under way, the save may still have gone through; calling the tool again answers either way, because an unchanged directory is reported as unchanged.

### One noun for a document, a deck and an app

An artifact is sometimes a document, sometimes a slide deck, sometimes a dashboard that behaves like an app. These stay one concept, with three additions, none of which is a new noun:

- **Capabilities.** A version declares what its page needs from the platform at run time: a small database of its own, a way to ask an agent, files it can offer for download. A page with no capabilities is plain static files, as today.
- **Data apart from versions.** Whatever a capability stores (rows in the artifact's database, files people add) belongs to the artifact, not to a version. Moving the published pointer to an older version changes the page and never the data.
- **Types.** A type is an artifact others are made from: it supplies the page and its capabilities, and the new artifact supplies only its content. "Document", "slides" and "dashboard" are types, so adding a kind of artifact means publishing a type, not changing the domain.

**Rules to add when these are built:** a version's capabilities never change; an artifact made from a type records the type and version it was made from; deleting an artifact deletes its data.

The [artifact capabilities proposal](artifact-capabilities.md) describes version declarations, sharing grants, the per-artifact database, and types.

## Skill

A skill becomes its own resource: `POST /v1/skills` with files, versions as full snapshots, checked for a valid `SKILL.md` when uploaded, listed with `GET /v1/skills`, and attached to an agent version (sessions can still add one). It shares the versioned-file storage with artifacts and none of the publication rules. Until this is built, the current convention stays.

## What is removed

| Removed | Replaced by |
|---|---|
| Outputs as an artifact with a derived id; its publisher; the "follows the directory" contract | Outputs saved as Files; the session's outputs record |
| `OpenArtifact`, version 0, `PUT /v1/artifacts/{id}/blobs/{sha256}`, per-blob upload lock | `POST /v1/files`, then versions that name file ids |
| The `skill` resource as a convention over artifacts | The Skill resource |
| One limit failure losing the whole folder | Each file saved or skipped on its own. The per-file size limit stays at 1 MiB until outputs can be streamed from the machine |
| "Publish" used for adding a version or saving outputs | "Publish" only for an artifact's public address |

## Order of work

| Step | Change | Depends on |
|---|---|---|
| 1 (built) | File aggregate, shared byte owner, `/v1/files`, CLI commands, proofs | |
| 2 (built) | `file` session resource under `/mnt/session/uploads`. Copying into the machine follows | 1 |
| 3 (built) | Outputs saved as Files; the session outputs record; remove the outputs publisher | 1 |
| 4 (built) | Artifact versions from file ids; remove empty artifacts and blob upload | 1 |
| 5 | Skill resource, attached to agents | 4 |
| 6 | File blocks in messages; add and remove resources on a running session | 2 |
| 7 (built) | A tool for the agent to create or update an artifact | 4 |
| 8 | Artifact capabilities, starting with a per-artifact database, with data kept apart from versions | 4 |
| 9 | Artifact types, with document, slides and dashboard as the first three | 8 |

Each step is one pull request with its rules proved or checked before it merges.

## Open questions

- **Copying bytes into an artifact.** A version of many large files copies them from file storage to artifact storage. This keeps ownership simple, but it has not been timed.
- **Saving large outputs.** Output files are read from the machine in small batches today. Raising the per-file output limit to the File limit needs a streaming path from the machine.
- **One owner object per file.** It keeps uploads and purges in order, as it does for artifacts. A session that saves many output files makes many of them; the cost has not been measured.
- **Model support for attachments** depends on the harness passing images and documents to each provider.
