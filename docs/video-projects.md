# Video project sample

The file-backed Web workspace has a **Video project** action. Create its Remotion
sample, send an ordinary request for a title, colors or motion direction, review
`composition.json`, and Apply or Discard the proposal. **Render preview** runs the
accepted composition through the supervised worker and exposes a playable H264
video. **Export video project** downloads the accepted standard TypeScript project,
local SVG asset, exact dependency manifest and complete installed official skill.
Writing projects and their collaboration ZIP keep their existing allowlist.

## Preparation

After the frozen dependency install, run `pnpm render:prepare`. It downloads the
public official Remotion skills distribution at
`a3f4098a2afd0e13f6a6f8c8760e275f75457ea9`, verifies SHA-256
`4845ab7cf1bda2784c6a2d71cb3c9653ca9ce276677c80e59757749e0a0d2362`, and prepares an
ignored build artifact. An offline operator may supply that exact archive with
`SCENESPARROW_REMOTION_SKILL_ARCHIVE=/path/to/remotion.tgz`. The checked-in source
contains the installer and source pin, rather than a copy of the upstream tree.
The complete 133-file `remotion-best-practices` package, version `4.0.547`, is
installed at `.agents/skills/remotion-best-practices/` in each project snapshot;
`skill-lock.json` records its provenance. The Web dialog displays its version and
revision. Exports preserve the package as a unit, including referenced resources.

Set `SCENESPARROW_RENDER_BROWSER` to an installed Chromium executable for local
video preview. Alternatively the renderer can use its already-installed Remotion
headless shell. Preview requests never download a browser. The Web Dockerfile
prepares the verified skill artifact at build time and installs distro Chromium
and CJK fonts separately from Electron. Foundation prepares the artifact before
native component tests and Web smoke; the dedicated browser fixture configures its
installed Playwright Chromium for rendering. Building and running this Docker
image is separate deployment evidence.

The exported project uses the pinned Remotion `4.0.543` dependencies already
verified by SceneSparrow. Run `npm install`, `npm run typecheck`, and
`npm run studio` or `npm run render` in the extracted project. Its entry is
`src/index.ts`; assets remain under `public/` and project data in
`composition.json`. No monorepo lockfile is copied into it.

## Capability boundary

The video path creates a staged project and delegates skill discovery and loading
to official `dsh-skill-filesystem` and `dsh-tool-skill` `0.2.2-rc.5`. Its capability
host configures one explicit staged skill root, disables default/user discovery
and watchers, rejects symlinks, and resolves the bundled creation reference inside
that package. The loaded skill and reference become model context through the
existing text Agent transport. This host exposes only the native skill loader;
it does not start a second general-purpose editing platform or grant filesystem
and shell tools to the writing runner.

The sample accepts precisely four data fields: an 80-character title, two hex
colors, and left/right motion. Rust validates model output, persists the request
before inference, and holds a reviewable proposal until user adoption. Stable
request IDs suppress duplicate dispatch. Interrupted requests retain their identity
and input and require a new explicit request. The sample retains at most 32
requests. Apply rechecks its captured revision and atomically points the saved
state to a complete immutable project snapshot. Repeated Apply returns the settled
result. Native work runs outside the Markdown writer lock.

The renderer bundles the shipped TypeScript entry with the accepted JSON props.
It never executes proposed code or user-supplied project files. Node heap, output
size, wall time and Linux worker RSS are bounded; process-group cleanup reaps the
render browser on interruption. Worker RSS sampling does not enforce the total
memory of every browser descendant. This restricted data capability supports the
fixture without enabling arbitrary generated code execution. A broader code editor
would require its own tested OS isolation boundary.

## Reproduction

`node --test tests/unit/video-project.test.mjs` verifies full package preservation,
native discovery/loading and reference containment. Infrastructure `video_projects`
tests cover durable proposals, repeated adoption, stale revisions, symlink denials,
restart recovery and native loading after extracting the actual export ZIP.

Run the explicit native render fixture with an installed browser:

```sh
SCENESPARROW_RENDER_BROWSER=/usr/bin/chromium \
  CARGO_INCREMENTAL=0 cargo test --locked -p scenesparrow-infrastructure \
  renders_adopted_project -- --ignored --nocapture
```

It writes the adopted project ZIP and H264 preview into `.artifacts/video-project/`.
`pnpm test:e2e:markdown tests/e2e/video-project.spec.ts` exercises actual Web
creation/export/render/playback plus a deterministic Agent review/adoption UI
fixture. Hosted inference and packaged desktop video operation are not covered.
