import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshot,
  loadProjectSkill,
  validateComposition,
} from "../../workers/render/src/video-project.mjs";
import {
  unpackSkill,
  skillPackage,
} from "../../workers/render/src/skill-package.mjs";

const composition = {
  title: "Hello, SceneSparrow / 幕雀",
  background: "#142d27",
  accent: "#d9edb2",
  direction: "right",
};
test("video composition capability admits only the bounded data fields", () => {
  assert.deepEqual(validateComposition(composition), composition);
  for (const value of [
    { ...composition, title: "" },
    { ...composition, title: "x".repeat(81) },
    { ...composition, title: "bad\nline" },
    { ...composition, background: "url(https://example.org/)" },
    { ...composition, accent: "red" },
    { ...composition, direction: "up" },
    { ...composition, code: "process.exit()" },
  ])
    assert.throws(
      () => validateComposition(value),
      /VIDEO_COMPOSITION_INVALID/,
    );
});
test("video installs the full pinned official package and the native tool loads both project locations", async () => {
  const archive = await readFile(
    new URL("../../workers/render/.assets/remotion-skill.tgz", import.meta.url),
  );
  assert.throws(
    () => unpackSkill(Buffer.from("untrusted archive")),
    /VIDEO_SKILL_INVALID/,
  );
  const files = unpackSkill(archive);
  assert.equal(files.size, 133);
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-video-skills-"));
  try {
    for (const location of ["original", "exported"]) {
      const directory = join(root, location);
      await snapshot(directory, composition);
      const loaded = await loadProjectSkill(directory);
      assert.deepEqual(loaded.skill, skillPackage);
      assert.match(loaded.content, /\.\/remotion-create\/REFERENCE\.md/);
      assert.equal(
        loaded.reference,
        files.get("remotion-create/REFERENCE.md").toString(),
      );
      for (const [path, bytes] of files)
        assert.deepEqual(
          await readFile(
            join(directory, ".agents/skills/remotion-best-practices", path),
          ),
          bytes,
        );
    }
    const project = join(root, "original");
    await symlink(
      join(root, "exported/package.json"),
      join(project, ".agents/skills/remotion-best-practices", "outside.json"),
    );
    await assert.rejects(
      () => loadProjectSkill(project),
      /VIDEO_SKILL_INVALID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
