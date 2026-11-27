# SceneSparrow video project

Install the exact dependencies with `npm install`, then run `npm run studio` or
`npm run render`. The standard Remotion entry is `src/index.ts` and its composition
reads project-local `composition.json` and `public/sparrow.svg`.

The full official `remotion-best-practices` package is installed under
`.agents/skills/`; `skill-lock.json` records its pinned source and integrity.
Compatible external Agents can discover it from this project root. SceneSparrow's
supervised preview accepts changes to the four composition data fields only.
