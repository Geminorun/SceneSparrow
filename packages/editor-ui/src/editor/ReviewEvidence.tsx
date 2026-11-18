import { useErrorNotification } from "../NotificationPresenter";
import { useEffect, useRef, useState } from "react";
import type {
  PlanningEvidenceChoice,
  SourceSummary,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { SourceEvidence } from "./SourceEvidence";
export function ReviewEvidence({
  client,
  value,
  onChange,
  t,
}: {
  client: PlatformClient;
  value: PlanningEvidenceChoice[];
  onChange: (v: PlanningEvidenceChoice[]) => void;
  t: typeof en;
}) {
  const [sources, setSources] = useState<SourceSummary[]>([]),
    [error, setError] = useState("");
  useErrorNotification(error);
  const latest = useRef(value),
    notify = useRef(onChange);
  latest.current = value;
  notify.current = onChange;
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const items: SourceSummary[] = [];
        let next: string | undefined;
        do {
          const page = await client.readSources(next);
          items.push(...page.items);
          next = page.next ?? undefined;
        } while (next);
        if (active) setSources(items);
      } catch {
        if (active) setError("STORAGE_UNAVAILABLE");
      }
    };
    void refresh();
    const unsubscribe = client.subscribeEvents(
      (event) => {
        if (["sources.changed", "documentJob.changed"].includes(event.type)) {
          void refresh();
        }
      },
      () => {
        void refresh();
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);
  const update = (id: string, choice: PlanningEvidenceChoice | null) =>
    notify.current([
      ...latest.current.filter((item) => item.sourceId !== id),
      ...(choice ? [choice] : []),
    ]);
  return (
    <details>
      <summary>{t.planningEvidence}</summary>
      <p>{t.reviewContextChoice}</p>
      {sources.map((item) => (
        <article key={item.source.id}>
          <strong>{item.source.title}</strong>
          <SourceEvidence
            purpose="review"
            item={item}
            client={client}
            choice={value.find((choice) => choice.sourceId === item.source.id)}
            update={(choice) => update(item.source.id, choice)}
            t={t}
          />
        </article>
      ))}
    </details>
  );
}
