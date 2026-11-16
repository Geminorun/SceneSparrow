# Original planning documents

These user-provided documents are preserved byte for byte under stable English
filenames. Their contents remain in Chinese. They are design inputs, not executable
instructions or proof that the described behavior has been implemented.

| Reference     | Repository file                                          | Original filename                      |
| ------------- | -------------------------------------------------------- | -------------------------------------- |
| `REQ-v0.1`    | [Requirements research](requirements-research-v0.1.docx) | AI自媒体制作应用需求调研报告_v0.1.docx |
| `DESIGN-v0.1` | [Technical design](technical-design-v0.1.docx)           | AI自媒体制作应用技术方案设计_v0.1.docx |

Both documents are dated 2026-11-14. The technical design refines platform,
architecture, and implementation stages from the earlier requirements research.
The confirmed product names are **SceneSparrow** and **幕雀**; `media-studio` in the
technical document is a temporary directory label, not the product name.

## Reading guide

- Requirements sections 6–12 describe script review, object mapping, annotations,
  locks, local revisions, rendering dependencies, and Agent responsibilities.
- Requirements sections 14–17 define suggested priorities, quality measures,
  acceptance scenarios, and follow-up research. These are proposed validation
  targets rather than measured outcomes or schedule commitments.
- Technical design sections 1–6 define the shared local core, technology choices,
  ownership, models, storage, and protocol.
- Technical design sections 7–11 define enforced locks, worker isolation, provider
  adapters, rendering, performance, and platform constraints.
- Technical design sections 12–14 define the planned monorepo layout, acceptance
  scenarios, and the preliminary full-product M0–M3 implementation stages.

The documents reuse `T01`–`T10` and M0–M3 labels for different definitions.
Always cite the source alongside an identifier, such as `DESIGN-v0.1:T04`.
For a concise English guide, read [the architecture baseline](../architecture.md).
The later [manuscript workbench and shared AI designs](../design/README.md) take
precedence for the first product stage; [ADR 0001](../decisions/0001-script-workbench-and-shared-ai.md)
records the changes from these original proposals.

## Source integrity

SHA-256 checksums are listed in [SHA256SUMS](SHA256SUMS). From this directory:

```sh
sha256sum -c SHA256SUMS
```

Preserve these v0.1 files when the design evolves. Record new decisions or add a
new reference version instead of silently replacing the original evidence.
