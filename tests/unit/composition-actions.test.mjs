import test from "node:test";
import assert from "node:assert/strict";
import { CompositionActions } from "../../packages/editor-ui/src/project-session/composition-actions.ts";
const turn = () => new Promise((resolve) => setTimeout(resolve, 5));
test("composition actions read final input once, wait for every owner, and bound/deduplicate queued intent", async () => {
  const actions = new CompositionActions();
  actions.composition("planning", true);
  actions.composition("body", true);
  let text = "partial",
    calls = [];
  const first = actions.run("start", () => calls.push(text));
  assert.equal(
    actions.run("start", () => calls.push("duplicate")),
    first,
  );
  for (let i = 0; i < 7; i++) void actions.run(`other-${i}`, () => {});
  assert.equal(
    await actions.run("overflow", () => calls.push("overflow")),
    false,
  );
  actions.composition("body", false);
  await turn();
  assert.deepEqual(calls, []);
  actions.composition("planning", false);
  text = "最终中文";
  await first;
  assert.deepEqual(calls, ["最终中文"]);
  actions.dispose();
});
test("unmount/context cancellation survives compositionend and immediate microtask delivery", async () => {
  for (const mode of ["cancel", "dispose", "invalid"]) {
    const actions = new CompositionActions();
    let valid = true,
      calls = 0;
    const pending = actions.run(
      "start",
      () => calls++,
      () => valid,
    );
    if (mode === "cancel") actions.cancel("start");
    else if (mode === "dispose") actions.dispose();
    else valid = false;
    assert.equal(await pending, false);
    assert.equal(calls, 0);
    actions.dispose();
  }
  const actions = new CompositionActions();
  actions.composition("input", true);
  let calls = 0;
  const pending = actions.run("start", () => calls++);
  actions.composition("input", false);
  actions.cancel();
  await turn();
  assert.equal(await pending, false);
  assert.equal(calls, 0);
  actions.dispose();
});
test("same-key immediate in-flight work is consumed once and a resumed composition postpones invocation", async () => {
  const actions = new CompositionActions();
  let calls = 0,
    release;
  const first = actions.run("start", () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  actions.composition("input", true);
  await turn();
  assert.equal(calls, 0);
  actions.composition("input", false);
  await turn();
  assert.equal(calls, 1);
  assert.equal(
    actions.run("start", () => calls++),
    first,
  );
  release(true);
  assert.equal(await first, true);
  actions.dispose();
});
test("one delivered action can cancel or invalidate another before invocation", async () => {
  const actions = new CompositionActions();
  actions.composition("input", true);
  let valid = true,
    calls = 0;
  const first = actions.run("navigate", () => {
    valid = false;
    actions.cancel("cancelled");
  });
  const second = actions.run(
    "invalid",
    () => calls++,
    () => valid,
  );
  const third = actions.run("cancelled", () => calls++);
  actions.composition("input", false);
  await Promise.all([first, second, third]);
  assert.equal(calls, 0);
  actions.dispose();
});

test("cancelling a scheduled key cannot delete a newer intent with the same key", async () => {
  const actions = new CompositionActions();
  let calls = 0;
  const old = actions.run("start", () => calls++);
  actions.cancel("start");
  actions.composition("input", true);
  const current = actions.run("start", () => calls++);
  await Promise.resolve();
  assert.equal(await old, false);
  actions.composition("input", false);
  await current;
  assert.equal(calls, 1);
  actions.dispose();
});

test("blur cleanup from an older composition cannot finalize a newly focused composition in any source", async () => {
  for (const source of ["manuscript", "planning", "review", "sources"]) {
    const actions = new CompositionActions();
    let commits = 0,
      calls = 0;
    actions.composition(source, true);
    const pending = actions.run("start", () => calls++);
    actions.blur(source, () => {
      commits++;
      actions.composition(source, false);
    });
    actions.composition(source, true);
    await turn();
    assert.equal(commits, 0);
    assert.equal(calls, 0);
    assert.equal(actions.composing, true);
    actions.blur(source, () => {
      commits++;
      actions.composition(source, false);
    });
    await pending;
    assert.equal(commits, 1);
    assert.equal(calls, 1);
    actions.dispose();
  }
});

test("different source/evidence intents remain independent and scoped owner cleanup cancels only its pending actions", async () => {
  const actions = new CompositionActions();
  actions.composition("planning", true);
  const calls = [];
  const first = actions.run("planning-evidence:first", () =>
    calls.push("first"),
  );
  const second = actions.run("planning-evidence:second", () =>
    calls.push("second"),
  );
  const source = actions.run("source:remove:third", () => calls.push("third"));
  actions.cancelScope("source:");
  actions.composition("planning", false);
  await Promise.all([first, second, source]);
  assert.deepEqual(calls, ["first", "second"]);
  actions.dispose();
});

test("cancel and requeue of the same captured key keeps separate bounded admission until each promise ends", async () => {
  const actions = new CompositionActions();
  let captures = 0,
    releases = 0;
  const cancelled = [];
  try {
    for (let n = 0; n < 8; n++) {
      cancelled.push(
        actions.runCaptured(
          "same-owner-key",
          () => ++captures,
          async () => assert.fail("cancelled"),
          () => true,
          () => releases++,
        ),
      );
      actions.cancel("same-owner-key");
    }
    assert.equal(actions.captured.size, 8);
    assert.equal(captures, 8);
    assert.equal(releases, 8);
    await assert.rejects(
      actions.runCaptured(
        "same-owner-key",
        () => ++captures,
        async () => true,
      ),
      /CAPTURE_BUSY/,
    );
    assert.equal(captures, 8);
    assert.deepEqual(await Promise.all(cancelled), Array(8).fill(false));
    assert.equal(actions.captured.size, 0);
    assert.equal(releases, 8);
    assert.equal(
      await actions.runCaptured(
        "same-owner-key",
        () => ++captures,
        async (input) => input,
        () => true,
        () => releases++,
      ),
      9,
    );
    assert.equal(actions.captured.size, 0);
    assert.equal(releases, 9);
  } finally {
    actions.dispose();
  }
});
