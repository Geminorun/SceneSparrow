import { useSyncExternalStore } from "react";
import type en from "../locales/en.json";
import { applicationPreferences } from "../app-preferences";
import type { AgentCatalog } from "./catalog";

export function AgentSettings({
  catalog,
  t,
  active,
}: {
  catalog: AgentCatalog;
  t: typeof en;
  active: boolean;
}) {
  const { engines, loading, load } = catalog;
  const defaults = useSyncExternalStore(
    applicationPreferences.subscribe,
    applicationPreferences.getSnapshot,
  ).agentDefault;
  const engine = engines.find((e) => e.id === defaults?.engineId) ?? engines[0];
  return (
    <section hidden={!active} className="agent-settings">
      <h3>{t.workspaceTab_agent}</h3>
      <p>{t.agentSettingsHelp}</p>
      <button disabled={loading} onClick={() => void load()}>
        {t.agentCheckConnection}
      </button>
      <label>
        {t.agentDefaultEngine}
        <select
          value={engine?.id ?? ""}
          onChange={(e) => {
            const next = engines.find(
              (engine) => engine.id === e.target.value,
            )!;
            applicationPreferences.update({
              agentDefault: {
                engineId: next.id,
                modelId: next.models[0]?.id ?? "",
              },
            });
          }}
        >
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.agentDefaultModel}
        <select
          disabled={!engine?.models.length}
          value={
            engine?.models.some((m) => m.id === defaults?.modelId)
              ? defaults!.modelId
              : (engine?.models[0]?.id ?? "")
          }
          onChange={(e) =>
            applicationPreferences.update({
              agentDefault: { engineId: engine!.id, modelId: e.target.value },
            })
          }
        >
          {!engine?.models.length && (
            <option value="">{t.agentNoModels}</option>
          )}
          {engine?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
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
          <ul>
            {e.models.map((m) => (
              <li key={m.id}>{m.label}</li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
