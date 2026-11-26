import test from "node:test";
import assert from "node:assert/strict";
import {
  ApplicationPreferencesStore,
  defaultPreferences,
  preferencesKey,
} from "../../packages/editor-ui/src/app-preferences.ts";
function storage(initial) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (key, next) => {
      assert.equal(key, preferencesKey);
      value = next;
    },
  };
}
test("application preferences default to ten seconds, persist all choices and reload independently of projects", () => {
  const disk = storage(null);
  const preferences = new ApplicationPreferencesStore(() => disk);
  assert.deepEqual(preferences.getSnapshot(), defaultPreferences);
  for (const saveMode of ["after_delay", "on_window_change", "off"])
    for (const saveDelaySeconds of [5, 10, 30]) {
      preferences.update({ saveMode, saveDelaySeconds });
      assert.deepEqual(
        new ApplicationPreferencesStore(() => disk).getSnapshot(),
        { version: 1, saveMode, saveDelaySeconds },
      );
    }
});
test("invalid versions, fields, malformed JSON and unavailable storage recover safely", () => {
  for (const value of [
    null,
    "broken",
    "null",
    "[]",
    '{"version":2,"saveMode":"off"}',
    '{"version":1,"saveMode":"invalid","saveDelaySeconds":2}',
  ]) {
    assert.deepEqual(
      new ApplicationPreferencesStore(() => storage(value)).getSnapshot(),
      defaultPreferences,
    );
  }
  const p = new ApplicationPreferencesStore(() => {
    throw Error("denied");
  });
  p.update({ saveMode: "off" });
  assert.equal(p.getSnapshot().saveMode, "off");
  const full = new ApplicationPreferencesStore(() => ({
    getItem: () => null,
    setItem: () => {
      throw Error("full");
    },
  }));
  full.update({ saveDelaySeconds: 30 });
  assert.equal(full.getSnapshot().saveDelaySeconds, 30);
});
test("cross-tab updates validate, notify once, ignore other storage and handle clear", () => {
  let listener;
  const disk = storage(null),
    p = new ApplicationPreferencesStore(() => disk, {
      addEventListener: (_event, callback) => {
        listener = callback;
      },
    });
  let calls = 0;
  const remove = p.subscribe(() => calls++);
  const event = {
    key: preferencesKey,
    storageArea: disk,
    newValue: '{"version":1,"saveMode":"off","saveDelaySeconds":30}',
  };
  listener(event);
  listener(event);
  assert.equal(calls, 1);
  assert.equal(p.getSnapshot().saveMode, "off");
  listener({ ...event, storageArea: storage(null), newValue: null });
  assert.equal(calls, 1);
  listener({ key: null, storageArea: disk, newValue: null });
  assert.deepEqual(p.getSnapshot(), defaultPreferences);
  assert.equal(calls, 2);
  remove();
  p.update({ saveMode: "off" });
  assert.equal(calls, 2);
});

test("Agent defaults persist with the existing application preferences and reject invalid settings", () => {
  const disk = storage(null),
    preferences = new ApplicationPreferencesStore(() => disk);
  preferences.update({
    agentDefault: { engineId: "codex", modelId: "openai.gpt-5.4" },
  });
  assert.deepEqual(
    new ApplicationPreferencesStore(() => disk).getSnapshot().agentDefault,
    { engineId: "codex", modelId: "openai.gpt-5.4" },
  );
  assert.equal(preferences.getSnapshot().saveDelaySeconds, 10);
  preferences.update({ agentDefault: { engineId: 1, modelId: "invalid" } });
  assert.equal(preferences.getSnapshot().agentDefault, undefined);
});
