import { useEffect, useRef, useState } from "react";
import type {
  AiSettingsView,
  AiSettings,
  AiEvidence,
  AiTestAction,
  AiTestReceipt,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "./locales/en.json";
const evidence = (): AiEvidence => ({
  state: "unknown",
  source: "unknown",
  scope: "",
  observedAt: null,
});
const presets = [
  ["OpenAI", "https://api.openai.com/v1"],
  ["DeepSeek", "https://api.deepseek.com/v1"],
  ["Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["Gemini", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ["Groq", "https://api.groq.com/openai/v1"],
  ["Ollama", "http://localhost:11434/v1"],
] as const;
export function AiSettings({
  client,
  t,
  active,
}: {
  client: PlatformClient;
  t: typeof en;
  active: boolean;
}) {
  const [view, setView] = useState<AiSettingsView | null>(null),
    [selected, setSelected] = useState(""),
    [label, setLabel] = useState(""),
    [root, setRoot] = useState(""),
    [auth, setAuth] = useState<"bearer" | "none">("bearer"),
    [key, setKey] = useState(""),
    [model, setModel] = useState(""),
    [models, setModels] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<AiTestReceipt | null>(null),
    [action, setAction] = useState<AiTestAction | null>(null);
  const [images, setImages] = useState<AiEvidence["state"]>("unknown"),
    [streaming, setStreaming] = useState<AiEvidence["state"]>("unknown"),
    [native, setNative] = useState<AiEvidence["state"]>("unknown"),
    [tokens, setTokens] = useState(1024),
    [temperature, setTemperature] = useState(""),
    [tokenField, setTokenField] = useState<
      "max_tokens" | "max_completion_tokens"
    >("max_tokens");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      const code = e instanceof Error ? e.message : "AI_ERROR";
      setError(code in t ? code : "AI_ERROR");
    } finally {
      setBusy(false);
    }
  };
  const load = () =>
    run(async () => {
      setView(await client.readAiSettings());
    });
  const activated = useRef(false);
  useEffect(() => {
    if (active && !activated.current) {
      activated.current = true;
      void load();
    }
    if (!active) setKey("");
  }, [active]);
  const choose = (id: string) => {
    setSelected(id);
    setKey("");
    setModels([]);
    setReceipt(null);
    setAction(null);
    const p = view?.settings.providers.find((p) => p.id === id);
    setLabel(p?.label ?? "");
    setRoot(p?.baseUrl ?? "");
    setAuth(p?.authMode ?? "bearer");
    const binding = view?.settings.bindings.find(
      (b) => b.category === "text" && b.providerId === id,
    );
    const m = view?.settings.models.find(
      (m) => m.providerId === id && m.id === binding?.modelId,
    );
    setModel(m?.id ?? "");
    setImages(m?.capabilities.images.state ?? "unknown");
    setStreaming(m?.capabilities.streaming.state ?? "unknown");
    setNative(m?.capabilities.nativeJson.state ?? "unknown");
    setTokenField(m?.tokenField ?? "max_tokens");
    setTokens(binding?.parameters.maxOutputTokens ?? 1024);
    setTemperature(
      binding?.parameters.temperatureMilli == null
        ? ""
        : String(binding.parameters.temperatureMilli / 1000),
    );
  };
  const update = async (settings: AiSettings) => {
    if (!view) return;
    setView(
      await client.updateAiSettings({
        expectedRevision: view.settings.revision,
        settings,
      }),
    );
  };
  const save = () =>
    run(async () => {
      if (!view) return;
      const s = structuredClone(view.settings),
        id = selected || crypto.randomUUID();
      const old = s.providers.find((p) => p.id === id);
      const profile = {
        id,
        label,
        adapter: "openai_compatible" as const,
        baseUrl: root,
        authMode: auth,
        credentialRevision: old?.credentialRevision ?? null,
        revision: old?.revision ?? 1,
      };
      s.providers = s.providers.filter((p) => p.id !== id);
      s.providers.push(profile);
      await update(s);
      setSelected(id);
      setAction(null);
      setReceipt(null);
    });
  const bind = () =>
    run(async () => {
      if (!view || !selected) return;
      const s = structuredClone(view.settings);
      const declared = (state: AiEvidence["state"]): AiEvidence =>
        state === "unknown"
          ? evidence()
          : {
              state,
              source: "user",
              scope: "User compatibility declaration",
              observedAt: new Date().toISOString(),
            };
      s.models = s.models.filter(
        (m) => !(m.providerId === selected && m.id === model),
      );
      s.models.push({
        providerId: selected,
        id: model,
        label: model,
        capabilities: {
          images: declared(images),
          streaming: declared(streaming),
          nativeJson: declared(native),
        },
        contextTokens: null,
        outputTokens: null,
        tokenField,
      });
      const previous = s.bindings.find((b) => b.category === "text");
      s.bindings = s.bindings.filter((b) => b.category !== "text");
      s.bindings.push({
        category: "text",
        providerId: selected,
        modelId: model,
        parameters: {
          temperatureMilli:
            temperature === "" ? null : Math.round(Number(temperature) * 1000),
          maxOutputTokens: tokens,
          requestStreaming: streaming === "supported",
          requestNativeJson: native === "supported",
        },
        revision: previous?.revision ?? 1,
      });
      await update(s);
      setAction(null);
      setReceipt(null);
    });
  const credential = (remove = false) =>
    run(async () => {
      if (!view || !selected) return;
      const value = key;
      setKey("");
      setView(
        await (remove ? client.deleteAiCredential : client.updateAiCredential)({
          expectedRevision: view.settings.revision,
          providerId: selected,
          secret: remove ? "" : value,
        }),
      );
      setAction(null);
      setReceipt(null);
    });
  const test = (repeat = false) =>
    run(async () => {
      if (!view || !selected || !model.trim()) return;
      const target = { providerId: selected, modelId: model, tokenField };
      const submitted =
        repeat && action
          ? action
          : {
              sessionId: view.sessionId,
              actionId: crypto.randomUUID(),
              target,
              fingerprint: (await client.prepareAiTest(target)).configuration
                .fingerprint,
            };
      setAction(submitted);
      if (!repeat) setReceipt(null);
      setReceipt(await client.testAiConnection(submitted));
    });
  const profile = view?.settings.providers.find((p) => p.id === selected);
  return (
    <section className="ai-settings" hidden={!active} aria-label={t.aiModels}>
      <h3>{t.aiModels}</h3>
      <p className="ai-protocol">{t.aiProtocol}</p>
      {error && (
        <p role="alert">
          {t[error as keyof typeof en]}{" "}
          <button onClick={() => void load()}>{t.aiReload}</button>
        </p>
      )}
      {!view ? (
        <p>{t.connecting}</p>
      ) : (
        <fieldset disabled={busy}>
          <p>{t.aiGlobal}</p>
          <p>
            {view.credentialBackend === "session_only"
              ? t.aiSessionOnly
              : t.aiNative}
          </p>
          <label>
            {t.aiProfile}
            <select value={selected} onChange={(e) => choose(e.target.value)}>
              <option value="">{t.aiNewProfile}</option>
              {view.settings.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.aiPreset}
            <select
              defaultValue=""
              onChange={(e) => {
                const p = presets[Number(e.target.value)];
                if (p) {
                  setRoot(p[1]);
                  if (!label) setLabel(p[0]);
                }
              }}
            >
              <option value="">{t.aiCustom}</option>
              {presets.map((p, i) => (
                <option key={p[0]} value={i}>
                  {p[0]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.aiLabel}
            <input
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label>
            {t.aiRoot}
            <input
              value={root}
              maxLength={8192}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <p>{t.aiRootHint}</p>
          <label>
            {t.aiAuth}
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value as typeof auth)}
            >
              <option value="bearer">{t.aiBearer}</option>
              <option value="none">{t.aiNoAuth}</option>
            </select>
          </label>
          <button
            onClick={() => void save()}
            disabled={!label.trim() || !root.trim()}
          >
            {t.aiSaveProfile}
          </button>
          {selected && (
            <>
              <button
                onClick={() =>
                  void run(async () => {
                    if (!view) return;
                    const s = structuredClone(view.settings);
                    s.providers = s.providers.filter((p) => p.id !== selected);
                    await update(s);
                    choose("");
                  })
                }
              >
                {t.aiRemoveProfile}
              </button>
              <p role="status">
                {profile?.credentialRevision &&
                view.presentCredentialRevisions.includes(
                  profile.credentialRevision,
                )
                  ? t.aiKeyPresent
                  : t.aiKeyMissing}
              </p>
              <label>
                {t.aiKey}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={auth === "none"}
                />
              </label>
              <button
                disabled={!key || auth === "none"}
                onClick={() => void credential()}
              >
                {t.aiSaveKey}
              </button>
              <button
                disabled={!profile?.credentialRevision}
                onClick={() => void credential(true)}
              >
                {t.aiDeleteKey}
              </button>
              <label>
                {t.aiModel}
                <input
                  value={model}
                  maxLength={256}
                  list="ai-models"
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id="ai-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <button
                onClick={() =>
                  void run(async () => {
                    setModels((await client.discoverAiModels(selected)).models);
                  })
                }
              >
                {t.aiDiscover}
              </button>
              <p>{t.aiDiscoveryHint}</p>
              <details className="ai-advanced">
                <summary>{t.aiAdvanced}</summary>
                <div>
                  {(
                    [
                      [t.aiImages, images, setImages],
                      [t.aiStreaming, streaming, setStreaming],
                      [t.aiNativeJson, native, setNative],
                    ] as const
                  ).map(([name, value, set]) => (
                    <label key={name}>
                      {name}
                      <select
                        value={value}
                        onChange={(e) =>
                          set(e.target.value as AiEvidence["state"])
                        }
                      >
                        <option value="unknown">{t.aiUnknown}</option>
                        <option value="supported">
                          {t.aiDeclaredSupported}
                        </option>
                        <option value="unsupported">
                          {t.aiDeclaredUnsupported}
                        </option>
                      </select>
                    </label>
                  ))}
                  <label>
                    {t.aiTokens}
                    <input
                      type="number"
                      min={16}
                      max={1000000}
                      value={tokens}
                      onChange={(e) => setTokens(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {t.aiTokenField}
                    <select
                      value={tokenField}
                      onChange={(e) =>
                        setTokenField(e.target.value as typeof tokenField)
                      }
                    >
                      <option value="max_tokens">max_tokens</option>
                      <option value="max_completion_tokens">
                        max_completion_tokens
                      </option>
                    </select>
                  </label>
                  <label>
                    {t.aiTemperature}
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperature}
                      onChange={(e) => setTemperature(e.target.value)}
                    />
                  </label>
                </div>
              </details>
              <button disabled={!model.trim()} onClick={() => void bind()}>
                {t.aiBindText}
              </button>
              <p>
                {t.aiTestTarget
                  .replace("{provider}", profile?.label ?? "")
                  .replace("{model}", model)
                  .replace("{root}", profile?.baseUrl ?? "")}
              </p>
              <p>{t.aiTestQuota}</p>
              <button disabled={!model.trim()} onClick={() => void test()}>
                {t.aiTest}
              </button>
              {action && !receipt && (
                <button onClick={() => void test(true)}>
                  {t.aiTestStatus}
                </button>
              )}
              {receipt && (
                <p>
                  {t.aiTestResultTarget
                    .replace("{model}", receipt.target.modelId)
                    .replace("{root}", receipt.providerRoot ?? "")}
                </p>
              )}
              {receipt && (
                <p role="status">
                  {receipt.status === "succeeded"
                    ? t.aiTestSuccess
                    : (t[receipt.error as keyof typeof en] ?? t.AI_ERROR)}
                </p>
              )}
            </>
          )}
          <p>{t.aiAudioReserved}</p>
          <p>{t.aiVideoReserved}</p>
        </fieldset>
      )}
    </section>
  );
}
