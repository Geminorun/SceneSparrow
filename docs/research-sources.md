# Selected-text research sources

The selection toolbar's **Ask** attaches the captured quote and document. It
waits for a question in the Agent composer. Sending that question creates an
explicitly read-only research turn. The application retrieves evidence before
sending the quote, question, excerpts, and bounded completed conversation history
to the text-only writing runner. The runner's tools and native Web search remain
disabled. Research cannot produce or apply a document proposal.

## Project references

The file-backed workspace does not have a Library. An operator can provide small
UTF-8 Markdown or text references directly in
`<SCENESPARROW_MARKDOWN_PROJECTS_DIR>/<project-id>/references/`. Only immediate
`.md` and `.txt` files are read; symlinks and nested directories are not followed.
A source's ID is `references/<filename>`. Its title is its first `# Heading`, or
the filename when there is no heading. These files are read-only inputs. They
are not added to collaboration ZIPs or exposed as general file capabilities.

Retrieval examines at most 32 directory entries, 32 KiB per file and 128 KiB in
total. It ranks references by distinct matching words and adjacent Chinese
character pairs from at most 512 characters each of the selection and question,
with at most 128 terms. A match needs two terms. It
keeps at most four sources and a character-safe excerpt of at most 1,600
characters per source. Matching project references are used first. Public
search is attempted when there is no match, no question term matches a reference,
or a reference could not be read within the limits. This lexical relevance check
is not factual verification; the answer must identify claims the excerpts do
not verify. Partial and unavailable outcomes remain visible in the saved turn.

## Configured public search

Set `SCENESPARROW_RESEARCH_SEARCH_URL` on the core, or on the Web supervisor /
Compose Web service. It is an operator-owned endpoint, not a model credential.
The Web supervisor forwards this one setting to the core. No endpoint is supplied
by the model or renderer. An unset, invalid, or unreachable endpoint leaves Web
editing available and records unavailable search when public evidence is needed.

Use an HTTPS URL with no user information, query string, fragment, or whitespace.
HTTP is accepted only for loopback hosts (`127.0.0.1`, `localhost`, `[::1]`) for
local adapters and deterministic tests. Redirects are rejected. The service makes
one GET with `q=<query>&format=json` and `Accept: application/json`. The query
contains at most 256 characters of the explicit quote and 256 characters of the
question (512 characters total). No surrounding document, annotations, project
identity, credentials, or conversation history are sent to search. Avoid selecting
private text when choosing public research.

The endpoint can be a SearXNG instance with JSON output enabled:

```json
{
  "results": [
    {
      "title": "Lake survey",
      "url": "https://example.org/survey",
      "content": "A retrieved excerpt supporting the result."
    }
  ]
}
```

A small existing search adapter can instead return:

```json
{
  "sources": [
    {
      "title": "Lake survey",
      "url": "https://example.org/survey",
      "excerpt": "A retrieved excerpt supporting the result."
    }
  ],
  "partial": false
}
```

The adapter uses built-in Node fetch with an eight-second request timeout and a
64 KiB response limit, supervised by the existing Rust process cleanup guard
with a ten-second outer deadline and cancellation polling. It accepts at most
16 result entries and retains at most four distinct HTTP(S) links, with bounded
titles, URLs and excerpts. Missing or unsafe entries and explicitly partial
responses produce a partial result. It fetches the configured search response
only; it does not follow result links or crawl pages. Sources are excerpts from
the configured service, not a claim that SceneSparrow independently fetched the
full linked page.

The conversation stores source IDs, supplied titles, validated links, excerpts,
retrieval status, original question, and captured quote before answer generation.
A failed answer keeps retrieved evidence. Cancellation stops retrieval and
inference through the same turn identity. A cancelled or unavailable query can
be retried explicitly as a new turn with its original quote while the captured
document revision is still valid. Source links are rendered from saved metadata;
model text cannot create a new citation link.
