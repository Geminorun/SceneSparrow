import test from "node:test";
import assert from "node:assert/strict";
import {
  presetProvider,
  modelParameters,
  newModel,
  bindText,
  saveModel,
  assignPreset,
  validModelId,
} from "../../packages/editor-ui/src/ai-settings/model.ts";
const parameters = (tokens) => ({
  temperatureMilli: null,
  maxOutputTokens: tokens,
  requestStreaming: false,
  requestNativeJson: false,
});
const provider = (id, root, servicePreset) => ({
  id,
  baseUrl: root,
  label: id,
  authMode: "none",
  credentialRevision: null,
  revision: 1,
  ...(servicePreset ? { servicePreset } : {}),
});
const settings = () => ({ providers: [], models: [], bindings: [] });
test("preset recognition never mutates and only adopts unambiguous official roots, preferring text binding", () => {
  const s = settings();
  s.providers = [
    provider("a", "https://api.openai.com/v1/"),
    provider("b", "https://api.openai.com/v1"),
    provider("proxy", "https://proxy.example/v1"),
  ];
  const original = structuredClone(s);
  assert.equal(presetProvider(s, "openai"), undefined);
  s.bindings.push({ category: "text", providerId: "b", modelId: "m" });
  assert.equal(presetProvider(s, "openai").id, "b");
  s.bindings = [];
  assert.deepEqual(s, original);
  s.providers = [provider("proxy", "https://api.openai.com/v1?key=x")];
  assert.equal(presetProvider(s, "openai"), undefined);
});
test("explicit preset reassignment preserves legacy identity, auth, credentials, models and defaults", () => {
  const s = settings();
  s.providers = [
    provider("old", "https://api.openai.com/v1", "openai"),
    provider("legacy", "http://localhost/v1"),
  ];
  s.models = [newModel("legacy", "manual")];
  s.bindings = [
    {
      category: "text",
      providerId: "legacy",
      modelId: "manual",
      parameters: parameters(128),
    },
  ];
  const original = structuredClone(s);
  assignPreset(s, "legacy", "openai");
  assert.equal(s.providers[0].servicePreset, undefined);
  assert.equal(s.providers[1].servicePreset, "openai");
  assert.deepEqual(s.providers[1], {
    ...original.providers[1],
    servicePreset: "openai",
  });
  assert.deepEqual(s.models, original.models);
  assert.deepEqual(s.bindings, original.bindings);
});
test("standalone model preferences seed from text before audio and preserve other bindings when saved or selected", () => {
  const s = settings(),
    model = newModel("p", "m");
  delete model.defaultParameters;
  model.outputTokens = 2048;
  s.models = [model];
  assert.deepEqual(modelParameters(s, model), parameters(2048));
  s.bindings = [
    {
      category: "audio",
      providerId: "p",
      modelId: "m",
      parameters: parameters(64),
    },
    {
      category: "text",
      providerId: "p",
      modelId: "m",
      parameters: parameters(512),
      revision: 1,
    },
  ];
  assert.deepEqual(modelParameters(s, model), parameters(512));
  const audio = structuredClone(s.bindings[0]);
  bindText(s, model);
  assert.equal(
    s.bindings.find((binding) => binding.category === "text").parameters
      .maxOutputTokens,
    512,
  );
  saveModel(s, { ...model, defaultParameters: parameters(1024) });
  assert.equal(
    s.bindings.find((binding) => binding.category === "text").parameters
      .maxOutputTokens,
    1024,
  );
  assert.deepEqual(s.bindings[0], audio);
  bindText(s);
  assert.deepEqual(s.bindings, [audio]);
});
test("manual Unicode IDs remain exact while labels respect the core UTF-8 budget and unknown capabilities stay unknown", () => {
  const id = "雀".repeat(80),
    model = newModel("p", id);
  assert.equal(model.id, id);
  assert.equal(new TextEncoder().encode(model.label).length, 120);
  assert.equal(validModelId(id), true);
  assert.equal(validModelId("雀".repeat(86)), false);
  assert.equal(validModelId("model\ncontrol"), false);
  assert.equal(validModelId(" "), false);
  assert.equal(model.capabilities.images.state, "unknown");
  assert.deepEqual(model.defaultParameters, parameters(4096));
});

test("secret entry is masked on first render, with secure password fallback and explicit reveal", async () => {
  const { supportsSecretMask, SecretEntry } =
    await import("../../packages/editor-ui/src/ai-settings/SecretEntry.tsx");
  const { createRequire } = await import("node:module");
  const require = createRequire(
    new URL("../../packages/editor-ui/package.json", import.meta.url),
  );
  const { createElement } = require("react"),
    { renderToStaticMarkup } = require("react-dom/server");
  const t = require("./src/locales/en.json");
  assert.equal(supportsSecretMask(undefined), false);
  assert.equal(supportsSecretMask({ supports: () => false }), false);
  assert.equal(supportsSecretMask({ supports: () => true }), true);
  const original = globalThis.CSS;
  const render = (revealed = false) =>
    renderToStaticMarkup(
      createElement(SecretEntry, {
        id: "uuid",
        value: "SYNTHETIC",
        revealed,
        onChange() {},
        onReveal() {},
        t,
      }),
    );
  try {
    globalThis.CSS = { supports: () => false };
    assert.match(render(), /type="password"/);
    globalThis.CSS = { supports: () => true };
    const masked = render();
    assert.match(masked, /type="text"/);
    assert.match(masked, /-webkit-text-security:disc/);
    assert.match(masked, /autoComplete="off"/);
    assert.match(masked, /name="scenesparrow-api-token-uuid"/);
    assert.doesNotMatch(masked, /new-password/);
    assert.match(render(true), /-webkit-text-security:none/);
  } finally {
    globalThis.CSS = original;
  }
});
