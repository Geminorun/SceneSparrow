import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEngine,
  ExternalWritingClient,
} from "@scenesparrow/platform-client";
import { useNoticeOwner } from "../feedback/NotificationPresenter";

// T03 supplies runtime discovery through the client; T02 never starts a process.
export const unavailableCatalog: AgentEngine[] = [
  { id: "codex", label: "Codex", available: false, models: [] },
];
export function useAgentCatalog(
  client: ExternalWritingClient | undefined,
  active: boolean,
) {
  const [engines, setEngines] = useState(unavailableCatalog);
  const [loading, setLoading] = useState(false);
  const notice = useNoticeOwner();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = client?.catalog
        ? await client.catalog()
        : unavailableCatalog;
      if (request === generation.current) setEngines(next);
    } catch (failure) {
      if (request === generation.current) notice.report(failure);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [client, notice.report]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  return { engines, loading, load };
}

export type AgentCatalog = ReturnType<typeof useAgentCatalog>;
