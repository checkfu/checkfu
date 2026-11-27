# Artifact capabilities

This proposal covers the per-artifact database, access from artifact pages, and artifact types. [Files and artifacts](files-and-artifacts.md) describes the current model.

## Where artifacts are today

An artifact is a named set of files with versions. A version is opened by a signed viewing link, or at a public address once the artifact is published. The content Worker serves files over `GET` and `HEAD` and responds to CORS preflight requests.

An artifact page runs in a sandbox with an opaque origin and holds no Checkfu API credentials. Checkfu serves the version’s files. This proposal adds a way for a page to read or submit data to the artifact’s own database.

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

A version may not hold files under the reserved top-level `_/` path. A page resolves capability calls against the artifact address root, including when the page is in a subdirectory. The page helper derives that root from the current URL using the content Worker’s address rules.

| Address | Root path |
|---|---|
| Signed viewing link | `/a/{token}/` |
| Path-based publication | `/p/{address}/` |
| Publication hostname | `/` |

The page stays in its opaque-origin sandbox and sends credentialless requests. The content Worker identifies capability routes before handling `OPTIONS`, advertises only the methods and request headers supported by that route, and authorizes the actual request against the address. Capability responses, including errors, use `Cache-Control: private, no-store`. [Fetch Standard](https://fetch.spec.whatwg.org/)

The content Worker stays read-only for files. Other methods are accepted only under `_/`, and only for capabilities the version declares.

### Granted by the link or the publication

A capability call is allowed only if the address it arrived at grants it.

- **Viewing link.** The link's signed claims gain a level: `view` (the default, files only), `read` or `write`. Creating a link names the level.
- **Publication.** An explicit grant sets the public level (`view`, `read` or `write`) and records the collection operations the version being published permits at that level. If the grant is omitted, a new publication starts at `view` and an existing publication keeps its saved grant.

In the API, creating a link and publishing both take `access`. A link answers with its `access`; a publication shows its `access` and its saved `grants`, one entry for each collection a visitor could use when the level was set:

```json
{ "access": "write", "grants": { "responses": "add", "settings": "read" } }
```

Each call uses the grant and the declaration for the version resolved by that address. A `write` link on a collection the version marks `"visitors": "read"` can only read. A signed link keeps its version and grant until it expires or its artifact is deleted. A public address grants only the operations allowed by both the saved publication grant and the version it currently serves. Following the latest version or moving an existing publication to a different version cannot exceed the saved grant. Access beyond those saved operations requires an explicit new grant from the owner. Unpublishing revokes the public address.

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

A page sends and receives the same shapes as the management API: `{"data": …}` in, and a document resource or `{"data": [...], "next_page": …}` out. Listing takes `limit` and `page`. Adding accepts an `Idempotency-Key`, so a form sent twice is stored once. A call the address does not allow answers 403, and an address that does not resolve answers 404. A request body may be at most 128 KiB.

The content Worker only routes the call: it checks the link's signature or the address's shape, then hands the call to the API Worker, which resolves the version, works out what the address allows, and runs the same document operations the management API uses.

**A page does not need to know its own address.** It loads a helper the platform serves beside its files:

```html
<script src="_/data.js"></script>
<script type="module">
  const responses = globalThis.artifactData.collection("responses")
  await responses.add({ answer: 42 })
</script>
```

The helper works out the address from where it was loaded, so the same page works from a link, a public path or a public hostname. A page in a folder loads `../_/data.js`. Each call returns a promise: `list({limit, page})`, `get(id)`, `add(data, {key})`, `put(id, data)` and `delete(id)`. A refused call rejects with an error that carries the status. The agent's `save_artifact` tool tells the agent about `artifact.json` and this helper.

A page is untrusted and may be public, so it is not given a query language. Documents with fixed limits can be bounded and checked. A query that scans a table cannot.

**What a visitor may do is set per collection**, by `visitors`:

| Value | A visitor with a `read` address | A visitor with a `write` address |
|---|---|---|
| `none` | Nothing | Nothing |
| `read` | List and get | List and get |
| `add` | Nothing | Add only. Cannot list, get, replace or remove |
| `write` | List and get | Everything |

`add` is what a form or a poll needs: anyone can submit, nobody can read or change what others submitted.

An authenticated client uses the artifact management API to manage its data.

```
GET                 /v1/artifacts/{artifact_id}/data
GET | POST          /v1/artifacts/{artifact_id}/data/{collection}
GET | PUT | DELETE  /v1/artifacts/{artifact_id}/data/{collection}/{id}
```

| Call | Meaning |
|---|---|
| `GET data` | The collections that hold a document, with how many documents and bytes are in each |
| `GET data/{collection}` | List documents, oldest first, with `limit` and `page` |
| `POST data/{collection}` | Add `{"data": …}` under a new id. A retry with the same `Idempotency-Key` returns the same document ID and its current contents. Reusing the key with different input answers 409 |
| `PUT data/{collection}/{id}` | Store `{"data": …}` under an id the client chooses, replacing what is there |
| `DELETE data/{collection}/{id}` | Remove one document |

A document is any JSON value, with arrays and objects nested at most 32 deep. Numbers are JSON numbers, so an integer beyond 2^53 loses precision. An `Idempotency-Key` protects a retry only while the document it added still exists. The owner may use any collection name, declared by a version or not, so a dashboard can be filled before its page exists and a dropped collection can still be read and emptied. A document over the size limit answers 400; a full collection or database answers 409.

This lets a client fill a dashboard or read a form’s responses. The agent has a tool of its own, `artifact_data`, for the artifacts it saved in its session: it names the artifact as it named it in `save_artifact`, a collection and an operation (list, get, add, put or delete). The call goes over a private Worker binding and is tied to the running turn. It reaches only artifacts that session created; an artifact named by another session, or by the owner through the API, is not found. Like the owner, the agent may use any collection, whatever the page's visitors may do.

The database allows up to 16 collections, 10,000 documents per collection, 64 KiB of encoded JSON per document, and 64 MiB of document data. Each mutation checks quotas and updates the counters in the same SQLite transaction. A page's calls are rate limited: 120 a minute for one caller on one artifact, and 1,200 a minute for an artifact from all callers. A caller is a network address, since there are no visitor accounts: an IPv4 address, or the /64 network of an IPv6 address. The platform counts at each of its locations, so the limits are a ceiling on abuse and not an exact quota. Only calls the address allows are counted, so a refused call or a made-up address cannot use up an artifact's budget. A call over a limit answers 429 with `Retry-After`. The owner's API is not limited this way. [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

### Data is kept apart from versions

The database belongs to the artifact, not to a version.

- Adding a version leaves the data as it is.
- Pointing a publication at an older version changes the page and never the data.
- A collection keeps its documents when a new version drops the declaration. The management API can still read and delete them. A visitor can reach the collection only through an address that resolves to a version still declaring it and grants the operation.
- Deleting the artifact revokes data access and schedules erasure. The database owner records a deletion marker and clears the documents in one transaction. Delayed calls that arrive after the marker are refused.

One SQLite-backed Durable Object owns each artifact’s database. It applies each mutation and its quota checks in one transaction. Access checks and a deletion marker keep delayed retries from recreating erased data.

## Types

A document, a slide deck and a dashboard are all artifacts. What differs is the page that shows the content. A type is that page, made once and reused.

- **A type is an artifact** marked as one. Its files are a page and its `artifact.json`.
- **An artifact made from a type** names an accessible type version and supplies its own content as a data file or documents in its database.
- **Opening it** serves the pinned template over the artifact’s content and database. The page’s capability declarations come from that template. Instance content cannot replace template paths, including the entry page and `artifact.json`. Grants come from the derived artifact’s own viewing link or publication.

The derived version keeps the template files and effective declaration it was built with. Publishing a new type version or deleting the source type does not remove those files. Adopting a newer template creates a new version of the derived artifact.

"Document", "slides" and "dashboard" are the first three types. Adding a kind of artifact then means publishing a type, not changing the platform.

## Rules to hold

These are to be proved or checked when each part is built, in the same way as the file and artifact rules.

- A version's capabilities are recorded when it is created and never change.
- A capability call is refused unless the version declares it and the address grants it.
- A visitor's access to a collection never exceeds the version's `visitors` value. Moving a publication to a different version never grants an operation the owner has not approved.
- Data belongs to exactly one artifact. No call reaches another artifact's data.
- Adding a version or changing a publication changes no data.
- Deletion revokes access, eventually erases the data, and prevents delayed writes from recreating it.
- The same page can call its capability route from a signed link, a public path, or a public hostname, including when the page is in a subdirectory. Preflight does not grant access.
- An artifact made from a type records the type and the version, and they never change for that version.

## Order of work

| Step | Change | Depends on |
|---|---|---|
| A (built) | Read and check `artifact.json`; record capabilities on the version; reserve `_/` | |
| B (built) | The artifact's database object and the owner's data API | A |
| C1 (built) | Levels on viewing links and publications, and the grant a publication saves | A |
| C2 (built) | The page's `_/data` calls through the content Worker | B, C1 |
| C3 (built) | Rate limits per caller and per artifact | C2 |
| D (built) | A tool for the agent to read and write an artifact's data | B |
| E | Types: marking an artifact as a type, making an artifact from one, serving the two together | A, C2 |
| F | The document, slides and dashboard types | E |


## Open questions

- **Live updates.** A dashboard page would poll `_/data` to see new numbers. Pushing changes to open pages is possible later and is not needed first.
- **Files people add.** A capability for a page to accept uploads would reuse files and the same grant model. It is not designed here.
- **Asking an agent from a page.** A page that sends a message to a session needs a decision about whose session it is and what it may cost. It is the capability most in need of its own note.
- **Abuse of public write access.** Rate limits and size limits bound the damage: about 1,200 calls a minute at each location, and 64 MiB for one artifact. Readers and writers share an artifact's budget, so ten callers reading at full rate can crowd out a form's writers. Separate budgets for reads and writes would fix that and are not built. Whether a public `write` level needs a further check before it is allowed is undecided.
