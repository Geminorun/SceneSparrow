import type { AiSettings } from "@scenesparrow/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEngine,
  ExternalWritingClient,
  PlatformClient,
} from "@scenesparrow/platform-client";
import { useSavedAiView, publishSavedAiView } from "../ai-settings/saved-view";
import { officialDeepseekProvider } from "../ai-settings/model";
import { useNoticeOwner } from "../feedback/NotificationPresenter";

// Missing platform support remains recoverable without touching built-in model services.
export const unavailableCatalog: AgentEngine[] = [
  { id: "codex", label: "Codex", available: false, models: [] },
];
export function useAgentCatalog(
  client: ExternalWritingClient | undefined,
  active: boolean,
  settingsClient?: PlatformClient,
) {
  const saved = useSavedAiView();
  const [engines, setEngines] = useState(unavailableCatalog);
  const [loading, setLoading] = useState(false);
  const notice = useNoticeOwner();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const [catalog, settings] = await Promise.allSettled([
        client?.catalog
          ? client.catalog()
          : Promise.resolve(unavailableCatalog),
        settingsClient
          ? settingsClient.readAiSettings()
          : Promise.resolve(null),
      ]);
      if (request !== generation.current) return;
      if (catalog.status === "fulfilled") setEngines(catalog.value);
      else notice.report(catalog.reason);
      if (settings.status === "fulfilled") {
        if (settings.value) publishSavedAiView(settings.value);
      } else notice.report(settings.reason);
    } catch (failure) {
      if (request === generation.current) notice.report(failure);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [client, settingsClient, notice.report]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const defaultChoice = defaultAgentChoice(engines, saved?.settings);
  return { engines, loading, load, defaultChoice };
}

export type AgentCatalog = ReturnType<typeof useAgentCatalog>;

export function defaultAgentChoice(
  engines: AgentEngine[],
  settings?: AiSettings,
) {
  const provider = settings && officialDeepseekProvider(settings);
  const binding = settings?.bindings.find(
    (b) => b.category === "text" && b.providerId === provider?.id,
  );
  const configured = engines.some(
    (e) => e.id === "deepseek" && e.status !== "not_configured",
  );
  return {
    engineId: configured ? "deepseek" : "codex",
    modelId: configured ? (binding?.modelId ?? "") : "",
  };
}

export function conversationDefaults(
  saved: { engineId: string; modelId: string } | undefined,
  fallback: { engineId: string; modelId: string },
) {
  return saved?.engineId === "deepseek" && !saved.modelId
    ? { ...saved, modelId: fallback.modelId }
    : (saved ?? fallback);
}
