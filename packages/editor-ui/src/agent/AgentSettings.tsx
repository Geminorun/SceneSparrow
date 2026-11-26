import { useRef, useState, useSyncExternalStore } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { AiTestAction, AiTestReceipt } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { applicationPreferences } from "../app-preferences";
import {
  officialDeepseekProvider,
  newModel,
  bindText,
} from "../ai-settings/model";
import { AiSettingsContent } from "../ai-settings/AiSettings";
import { useAiSettings } from "../ai-settings/useAiSettings";
import { SecretEntry } from "../ai-settings/SecretEntry";
import { OperationStatus } from "../ai-settings/OperationStatus";
import { errorMessage } from "../feedback/notifications";
import { conversationDefaults, type AgentCatalog } from "./catalog";

export function AgentSettings({
  catalog,
  client,
  open,
  t,
  active,
}: {
  catalog: AgentCatalog;
  client: PlatformClient;
  open: boolean;
  t: typeof en;
  active: boolean;
}) {
  const { engines, loading, load } = catalog;
  const c = useAiSettings(client, open, active);
  const saved = useSyncExternalStore(
    applicationPreferences.subscribe,
    applicationPreferences.getSnapshot,
  ).agentDefault;
  const defaults = conversationDefaults(saved, catalog.defaultChoice);
  const engine = engines.find((e) => e.id === defaults.engineId);
  const settings = c.view?.settings;
  const provider = settings && officialDeepseekProvider(settings);
  const writingBinding = settings?.bindings.find((b) => b.category === "text");
  const harnessBinding =
    writingBinding?.providerId === provider?.id ? writingBinding : undefined;
  const deepseek = engines.find((e) => e.id === "deepseek");
  const testModelId =
    harnessBinding?.modelId ??
    (defaults.engineId === "deepseek" ? defaults.modelId : "");
  const [compatibility, setCompatibility] = useState<"services" | "defaults">(
    "services",
  );
  const selection = provider?.id ?? "deepseek";
  const draft = c.providerDraft(selection);
  const operation = c.providerOperation(selection);
  const keySaved =
    !!provider?.credentialRevision &&
    !!c.view?.presentCredentialRevisions.includes(provider.credentialRevision);
  const [testing, setTesting] = useState(false);
  const testBusy = useRef(false);
  const [test, setTest] = useState<{
    signature: string;
    receipt?: AiTestReceipt;
    error?: unknown;
  } | null>(null);
  const submitted = useRef<{ signature: string; action: AiTestAction } | null>(
    null,
  );
  const signature = JSON.stringify([
    provider?.id,
    provider?.baseUrl,
    provider?.credentialRevision,
    testModelId,
  ]);
  const current = useRef({ signature, active });
  current.current = { signature, active };
  const testResult = test?.signature === signature ? test : null;
  async function testModel() {
    if (!provider || !c.view || !client.agent?.testDeepseek || testBusy.current)
      return;
    testBusy.current = true;
    setTesting(true);
    const captured = signature;
    try {
      const target = { providerId: provider.id, modelId: testModelId };
      // Catalog choices become saved models without changing the direct API text binding.
      if (
        !settings!.models.some(
          (m) => m.providerId === target.providerId && m.id === target.modelId,
        )
      )
        await c.mutate("agent-model", (s) =>
          s.models.push(newModel(target.providerId, target.modelId)),
        );
      if (current.current.signature !== captured || !current.current.active)
        return;
      const prepared = (await client.prepareAiTest(target)).configuration;
      if (
        current.current.signature !== captured ||
        !current.current.active ||
        prepared.provider.id !== provider.id ||
        prepared.model.id !== testModelId ||
        prepared.provider.baseUrl !== provider.baseUrl ||
        prepared.provider.credentialRevision !== provider.credentialRevision
      )
        return;
      const fingerprint = prepared.fingerprint;
      const previous = submitted.current;
      const action =
        previous?.signature === captured &&
        previous.action.fingerprint === fingerprint
          ? previous.action
          : {
              target,
              fingerprint,
              sessionId: c.view.sessionId,
              actionId: crypto.randomUUID(),
            };
      submitted.current = { signature: captured, action };
      const receipt = await client.agent.testDeepseek(action);
      setTest({ signature: captured, receipt });
      // A completed result permits only an explicitly requested new test.
      submitted.current = null;
    } catch (error) {
      setTest({ signature: captured, error });
    } finally {
      testBusy.current = false;
      setTesting(false);
    }
  }
  return (
    <section hidden={!active} className="agent-settings">
      <h3>{t.workspaceTab_agent}</h3>
      <p>{t.agentSettingsHelp}</p>
      <OperationStatus operation={c.operations.load} t={t} />
      <button
        disabled={loading}
        onClick={() => {
          void load();
          void c.load();
        }}
      >
        {t.agentCheckConnection}
      </button>
      <label>
        {t.agentDefaultEngine}
        <select
          value={engine?.id ?? ""}
          onChange={(e) =>
            applicationPreferences.update({
              agentDefault: {
                engineId: e.target.value,
                modelId:
                  e.target.value === "deepseek"
                    ? (harnessBinding?.modelId ?? "")
                    : (engines.find((engine) => engine.id === e.target.value)
                        ?.models[0]?.id ?? ""),
              },
            })
          }
        >
          {!engine && <option value="">{t.AGENT_UNAVAILABLE}</option>}
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      {(saved || defaults.engineId !== "deepseek") && (
        <label>
          {t.agentDefaultModel}
          <select
            disabled={!engine?.models.length}
            value={defaults.modelId}
            onChange={(e) =>
              applicationPreferences.update({
                agentDefault: { engineId: engine!.id, modelId: e.target.value },
              })
            }
          >
            <option value="">{t.deepseekChooseModel}</option>
            {!!defaults.modelId &&
              !engine?.models.some((m) => m.id === defaults.modelId) && (
                <option value={defaults.modelId}>{defaults.modelId}</option>
              )}
            {engine?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {!!defaults.modelId &&
        !engine?.models.some((m) => m.id === defaults.modelId) && (
          <p role="status">{t.AGENT_MODEL_UNAVAILABLE}</p>
        )}
      {settings && (
        <>
          <label>
            {t.deepseekWritingModel}
            <select
              value={harnessBinding?.modelId ?? ""}
              disabled={
                !provider ||
                !deepseek?.models.length ||
                c.operations["writing-model"]?.busy
              }
              onChange={(event) => {
                const modelId = event.target.value;
                if (!modelId || !provider) return;
                void c.mutate("writing-model", (s) => {
                  let model = s.models.find(
                    (m) => m.providerId === provider.id && m.id === modelId,
                  );
                  if (!model) {
                    model = newModel(provider.id, modelId);
                    s.models.push(model);
                  }
                  bindText(s, model);
                });
              }}
            >
              <option value="">
                {writingBinding && !harnessBinding
                  ? t.deepseekKeepDirect
                  : t.deepseekChooseModel}
              </option>
              {harnessBinding &&
                !deepseek?.models.some(
                  (m) => m.id === harnessBinding.modelId,
                ) && (
                  <option value={harnessBinding.modelId}>
                    {harnessBinding.modelId}
                  </option>
                )}
              {deepseek?.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{t.deepseekWritingHelp}</p>
          {harnessBinding &&
            !deepseek?.models.some((m) => m.id === harnessBinding.modelId) && (
              <p role="status">{t.AGENT_MODEL_UNAVAILABLE}</p>
            )}
          <OperationStatus operation={c.operations["writing-model"]} t={t} />
        </>
      )}
      {engines.map((e) => (
        <article key={e.id}>
          <strong>{e.label}</strong>
          <p role="status">
            {e.available
              ? e.id === "deepseek"
                ? t.deepseekConnected
                : t.agentAvailable
              : e.status === "not_configured"
                ? e.id === "deepseek"
                  ? t.deepseekNotConfigured
                  : t.AGENT_NOT_CONFIGURED
                : e.status === "not_authenticated"
                  ? e.id === "deepseek"
                    ? t.deepseekMissingCredential
                    : t.AGENT_NOT_AUTHENTICATED
                  : t.AGENT_UNAVAILABLE}
          </p>
          {e.id === "deepseek" && settings && (
            <>
              {keySaved && <p>{t.aiKeySavedLabel}: ••••••••</p>}
              <SecretEntry
                id="agent-deepseek"
                value={draft.key}
                revealed={draft.reveal}
                disabled={operation?.busy}
                t={t}
                onChange={(key) =>
                  c.editProvider(selection, {
                    key,
                    root: provider?.baseUrl ?? "https://api.deepseek.com/v1",
                  })
                }
                onReveal={() =>
                  c.editProvider(selection, { reveal: !draft.reveal })
                }
              />
              <button
                disabled={!draft.key || operation?.busy}
                onClick={() => {
                  void c
                    .saveProvider(selection, provider?.id)
                    .then(() => load());
                }}
              >
                {keySaved ? t.aiReplaceKey : t.aiSaveKey}
              </button>
              <OperationStatus operation={operation} t={t} />
              {operation?.credential === "unknown" && (
                <p role="status">{t.aiCredentialUnknown}</p>
              )}
              <p className="muted">{t.aiTestQuota}</p>
              <button
                disabled={
                  testing ||
                  !keySaved ||
                  !e.available ||
                  !e.models.some((m) => m.id === testModelId)
                }
                onClick={() => void testModel()}
              >
                {t.deepseekTestModel}
              </button>
              {testing && <p role="status">{t.aiWorking}</p>}
              {testResult && (
                <p role="status">
                  {testResult.receipt?.status === "succeeded"
                    ? t.deepseekTestSuccess
                    : errorMessage(
                        testResult.error ??
                          testResult.receipt?.error ??
                          "AGENT_DEEPSEEK_UPSTREAM_FAILED",
                        t,
                      )}
                </p>
              )}
            </>
          )}
        </article>
      ))}
      <details className="agent-compatibility">
        <summary>{t.deepseekCompatibility}</summary>
        <p>{t.deepseekCompatibilityHelp}</p>
        <div className="ai-inline-actions">
          <button
            aria-pressed={compatibility === "services"}
            onClick={() => setCompatibility("services")}
          >
            {t.aiModels}
          </button>
          <button
            aria-pressed={compatibility === "defaults"}
            onClick={() => setCompatibility("defaults")}
          >
            {t.aiDefaultModels}
          </button>
        </div>
        <AiSettingsContent
          controller={c}
          directOnly
          t={t}
          open={open}
          active={active}
          section={compatibility}
        />
      </details>
    </section>
  );
}
