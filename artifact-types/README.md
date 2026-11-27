# Artifact types

A type is an artifact that other artifacts are made from: it supplies the page, and the new artifact supplies only its content.

| Type | The new artifact supplies |
|---|---|
| `document` | `content.md` |
| `slides` | `content.md`, with `---` between slides |
| `dashboard` | Nothing; numbers go in its `numbers` collection |

To use one, create an artifact from its directory, for example named `document`, with `index.html`, `artifact.json` and `README.md`. Then:

- **Through the API:** create an artifact with `made_from: { "artifact_id": …, "version": … }` and its own files.
- **From an agent:** attach the type to the session as an artifact resource. The agent reads `/mnt/artifacts/<name>/README.md` and calls `save_artifact` with `made_from: "/mnt/artifacts/<name>"`.

Each type's `README.md` says what content it expects.
