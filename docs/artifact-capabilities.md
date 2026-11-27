# Artifact capabilities

Status: a design note. Nothing here is built. It follows `docs/files-and-artifacts.md` and settles the shape of the next three steps: the per-artifact database, the page's access to it, and artifact types.

## Where artifacts are today

An artifact is a named set of files with versions. A version is opened by a signed viewing link, or at a public address once the artifact is published. Both are served by the content Worker, which only answers `GET` and `HEAD`.

A page runs in a sandbox with no origin of its own. It has no cookies, no storage and no identity, and it cannot call the API: it holds no key. So a page today can only show what its files contain. A dashboard is frozen at the moment it was saved, and a form has nowhere to send what is typed into it.

## What a capability is

A capability is something the platform does for a page at run time, which static files cannot do. A page with no capabilities is exactly what an artifact is today.

Three decisions shape every capability:

| Decision | Choice | Why |
|---|---|---|
| Who declares it | The version, in a file | A version's files never change, so its capabilities never change either. No command is needed to keep them fixed. |
| Where the page calls it | Under the address it was opened at | The page holds no key. The address it was given is the only thing it has. |
| What grants access | The link or publication | The owner decides who can do what when sharing, not the page's author. |

### Declared by the version

A version that needs a capability has an `artifact.json` at its top level:

```json
{
  "capabilities": {
    "database": {
      "collections": {
        "responses": { "visitors": "add" },
        "settings": { "visitors": "read" }
      }
    }
  }
}
```

The file is read and checked when the version is created. A file that does not parse, or names a capability that does not exist, refuses the version with a 400. The capabilities are recorded on the version and shown on the artifact and version resources, so nothing has to open the file again to know them.

Because it is a file, every way of making a version carries it: the API, the CLI and the agent's `save_artifact` tool.

### Called under the page's own address

Capability endpoints live under one reserved path, `_/`, beside the page's files:

```
<address>/index.html          the page
<address>/_/data/responses    a capability call
```

A version may not hold files under `_/`. The page calls a relative URL, so the same page works from a viewing link and from a public address without knowing which it is on.

The content Worker stays read-only for files. Other methods are accepted only under `_/`, and only for capabilities the version declares.

### Granted by the link or the publication

A capability call is allowed only if the address it arrived at grants it.

- **Viewing link.** The link's signed claims gain a level: `view` (the default, files only), `read` or `write`. Creating a link names the level.
- **Publication.** Publishing names the level for the public: `view`, `read` or `write`. The default is `view`.

The page's declaration is the ceiling. A `write` link on a collection the version marks `"visitors": "read"` can still only read. The lower of the two always applies.

There are no visitor accounts. A call is made by "whoever holds this address". Knowing who a visitor is would be a capability of its own, and is not designed here.

## The database

The first capability is a small database that belongs to the artifact.

**It holds documents, not tables.** A database has named collections. A collection holds JSON documents by id. The calls are list, get, put and delete:

| Call | Meaning |
|---|---|
| `GET _/data/{collection}` | List documents, oldest first, in pages |
| `GET _/data/{collection}/{id}` | One document |
| `POST _/data/{collection}` | Add a document under a new id |
| `PUT _/data/{collection}/{id}` | Replace a document |
| `DELETE _/data/{collection}/{id}` | Remove a document |

A page is untrusted and may be public, so it is not given a query language. Documents with fixed limits can be bounded and checked. A query that scans a table cannot.

**What a visitor may do is set per collection**, by `visitors`:

| Value | A visitor with a `read` address | A visitor with a `write` address |
|---|---|---|
| `none` | Nothing | Nothing |
| `read` | List and get | List and get |
| `add` | Nothing | Add only. Cannot list, get, replace or remove |
| `write` | List and get | Everything |

`add` is what a form or a poll needs: anyone can submit, nobody can read or change what others submitted.

**The owner always has full access** through the API, with the API key:

```
GET | PUT | DELETE  /v1/artifacts/{artifact_id}/data/{collection}/{id}
GET | POST          /v1/artifacts/{artifact_id}/data/{collection}
```

This is how an agent fills a dashboard's numbers, and how a client reads a form's responses. A tool for the agent to write data follows the same path as `save_artifact`.

**Limits.** At most 16 collections, 10,000 documents in a collection, 64 KiB in a document and 64 MiB in a database. A call that would pass one is refused. Calls from one address are rate limited.

### Data is kept apart from versions

The database belongs to the artifact, not to a version.

- Adding a version leaves the data as it is.
- Pointing a publication at an older version changes the page and never the data.
- A collection a new version stops declaring keeps its documents. The owner can still read and delete them. Visitors cannot reach it.
- Deleting the artifact deletes its data.

One storage object per artifact holds the database. It is the only writer, so two calls at once are applied one after the other.

## Types

A document, a slide deck and a dashboard are all artifacts. What differs is the page that shows the content. A type is that page, made once and reused.

- **A type is an artifact** marked as one. Its files are a page and its `artifact.json`.
- **An artifact made from a type** names the type and one of its versions, and supplies only content: a data file, or documents in its database.
- **Opening it** serves the type's page over the artifact's own content and data.

The type's version is pinned when the artifact's version is made. A new version of a type changes nothing that already exists. Moving an artifact to a newer type version is adding a version to that artifact.

"Document", "slides" and "dashboard" are the first three types. Adding a kind of artifact then means publishing a type, not changing the platform.

## Rules to hold

These are to be proved or checked when each part is built, in the same way as the file and artifact rules.

- A version's capabilities are recorded when it is created and never change.
- A capability call is refused unless the version declares it and the address grants it.
- A visitor's access to a collection never exceeds the version's `visitors` value.
- Data belongs to exactly one artifact. No call reaches another artifact's data.
- Adding a version or changing a publication changes no data.
- No data remains for a deleted artifact.
- An artifact made from a type records the type and the version, and they never change for that version.

## Order of work

| Step | Change | Depends on |
|---|---|---|
| A | Read and check `artifact.json`; record capabilities on the version; reserve `_/` | |
| B | The artifact's database object and the owner's data API | A |
| C | Levels on viewing links and publications; the page's `_/data` calls; rate limits | B |
| D | A tool for the agent to write an artifact's data | B |
| E | Types: marking an artifact as a type, making an artifact from one, serving the two together | A, C |
| F | The document, slides and dashboard types | E |

Each step is one pull request that states what it leaves out.

## Open questions

- **Live updates.** A dashboard page would poll `_/data` to see new numbers. Pushing changes to open pages is possible later and is not needed first.
- **Files people add.** A capability for a page to accept uploads would reuse files and the same grant model. It is not designed here.
- **Asking an agent from a page.** A page that sends a message to a session needs a decision about whose session it is and what it may cost. It is the capability most in need of its own note.
- **Abuse of public write access.** Rate limits and size limits bound the damage. Whether a public `write` level needs a further check before it is allowed is undecided.
