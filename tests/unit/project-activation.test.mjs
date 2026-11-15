import test from "node:test";
import assert from "node:assert/strict";
import { activateProject } from "../../apps/desktop/src/project-activation.ts";
test("owned/disappeared candidate after preflight restores previous project owner and variables", async () => {
  for (const reason of ["owned by another core", "removed after inspection"]) {
    let directory = "original",
      alive = true;
    const calls = [];
    const result = await activateProject("original", "candidate", {
      stop: async () => {
        calls.push(["stop", directory]);
        alive = false;
      },
      start: async (path) => {
        calls.push(["start", path]);
        directory = path;
        if (path === "candidate") throw Error(reason);
        alive = true;
      },
    });
    assert.deepEqual(result, { directory: "original", changed: false });
    assert.equal(alive, true);
    assert.equal(directory, "original");
    assert.deepEqual(calls, [
      ["stop", "original"],
      ["start", "candidate"],
      ["stop", "candidate"],
      ["start", "original"],
    ]);
  }
});
test("failed rollback is explicit and never reports a healthy candidate or project switch", async () => {
  await assert.rejects(
    activateProject("original", "candidate", {
      stop: async () => {},
      start: async () => {
        throw Error("unavailable");
      },
    }),
    /PROJECT_REOPEN_FAILED/,
  );
  const calls = [];
  const result = await activateProject("original", "candidate", {
    stop: async () => calls.push("stopped"),
    start: async (path) => calls.push(path),
  });
  assert.deepEqual(result, { directory: "candidate", changed: true });
  assert.deepEqual(calls, ["stopped", "candidate"]);
});
