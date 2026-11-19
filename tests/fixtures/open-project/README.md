# Open-project OP1 proof fixtures

These are sanitized source-only examples; they contain no management DB, keys or
user data. `validation.json` is executed by both Node and Rust domain tests and
records stable result/error codes for manifests, paths and media declarations.
Path checks use segment validation and a conservative NFC/uppercase/lowercase/NFC
collision key, including directory prefixes. They are logical only; filesystem
link and race enforcement belongs to OP2.

`identity-corpus.json` records original UTF-8 strings (JSON escapes preserve BOM,
CRLF, trailing whitespace and Unicode), exact inserted source, ordered IDs and
addressable leaf kinds. Node verifies exact output, reparsing and metadata-free
CommonMark AST equality, including list tightness, code payload and raw HTML.
`identity-read-corpus.json` adds multiple/consecutive explicit empty root
paragraphs, literal markers and duplicate/missing/ambiguous failure cases. Both
corpora can be reused by native codec implementations without a JavaScript runtime.
The cases cover nested lists/quotes, ATX/setext headings, code-only tight items,
empty root/list/quote leaves, empty parents with nested items, multiple paragraphs
within an item, inline marks/breaks, literal markers, raw HTML and table-like text.
CommonMark treats the table-like text as a paragraph; no GFM visual editor or
semantic table support is claimed.

The reserved comments use canonical UUIDv4 IDs. `block` standalone comments bind
the following sibling leaf in the same container (never a list/quote container).
Container paragraphs/headings use an inline suffix; nonempty ATX headings can also
read a prefix. Root ordinary leaves use standalone comments. Code uses a standalone
comment with no blank separator to retain tight-list meaning. `empty` standalone
comments explicitly represent zero-content paragraphs and consume no following
sibling. Root empty markers may appear consecutively or beside ordinary blocks;
inside a list item/quote only nested containers may coexist with its empty marker.
Metadata under marks/links, inline empty markers and ambiguous container ownership
fail. Insertion reparses and checks semantic equality before returning a candidate.
The legacy normalized serializer is independent and remains unchanged.

`SourceBlock` owns only its leaf span, excluding child containers. `listItemAddress`
is a document-local structural mapping hint, not a persistent identity. A simple
legacy list item maps to its paragraph leaf ID; multi-paragraph items have separate
leaf IDs and cannot silently assign one prior identity to all paragraphs. Metadata
is removed by the `sourceMeaning` projection; the product speech/export pipeline is
not connected in OP1. Required IDs must be supplied from trusted management state
when checking edits. Generic source patches deliberately do not authorize changes;
a consumer must parse/validate the candidate with its protected IDs before saving.

Text-only needs only project.json/manuscript.md. The Remotion directory has its own
public dependency lockfile and scripts; see its README for the trusted standalone
render. This proof does not initialize projects or enable arbitrary product code.
