# Standalone Remotion fixture

Run with Node 24 and pnpm 11.25.0, from this directory or a fresh copy:

```sh
pnpm install --frozen-lockfile
pnpm compositions
pnpm render
pnpm still
```

`src/index.ts` registers `OpenProjectExample`: 320 × 180, 24 fps, 24 frames.
The project uses standard `public/` and `staticFile()` conventions, only public
pinned dependencies, and no application API, workspace imports, AI settings or DB.
Remotion CLI manages its rendering browser separately. An existing Chromium can
be selected with `--browser-executable=/absolute/path/to/chromium`.

The bird SVG and source were authored for this fixture and are MIT licensed in
LICENSE. There is no audio. No fonts or remote media are loaded. Remotion and
other dependencies retain their own licenses; consult Remotion's licensing terms
for your use. Output is developer-generated and should stay outside the fixture.
Rendering this reviewed fixture does not establish product execution isolation.
