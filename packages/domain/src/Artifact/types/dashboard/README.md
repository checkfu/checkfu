# Dashboard

A page of numbers that it reads from the artifact's own database and refreshes every 30 seconds.

Make an artifact from this type. It needs no files of its own. Then write documents to its `numbers` collection, with the `artifact_data` tool or the data API:

- Each document is one card, in the order written. Its `data` is `{ "label": "Revenue", "value": 1200, "unit": "USD", "note": "up 18%" }`. Only `value` is required; the document id is the label when none is given. A bare number or text also works as the value.
- The document with id `title` holds the page title as text.

Change a number by putting its document again under the same id.

The page only reads. Whoever opens it needs an address shared with `read` access: a link made with `access: "read"`, or a publication with `access: "read"`.

Do not supply `index.html` or `artifact.json`; they come from the type.

The dashboard refreshes every 30 seconds and shows the first 100 documents. The optional title counts toward this limit.
