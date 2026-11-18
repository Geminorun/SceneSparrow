import { useErrorNotification } from "../NotificationPresenter";
import { useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { ReviewMessage } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
export function ReviewConversation({
  client,
  id,
  t,
  selected,
  onSelected,
}: {
  client: PlatformClient;
  id: string;
  t: typeof en;
  selected: string[];
  onSelected: (ids: string[]) => void;
}) {
  const [messages, setMessages] = useState<ReviewMessage[]>([]),
    [cursor, setCursor] = useState<number | null>(null),
    [error, setError] = useState("");
  useErrorNotification(error);
  const request = useRef(0);
  const load = (before?: number) => {
    const n = ++request.current;
    void client.reviewMessages(id, before).then(
      (p) => {
        if (n === request.current) {
          setMessages((old) => (before ? [...p.messages, ...old] : p.messages));
          setCursor(p.nextCursor);
        }
      },
      (e) => {
        if (n === request.current) setError(e.message);
      },
    );
  };
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) load();
      }}
    >
      <summary>{t.reviewConversation}</summary>
      <p>{t.reviewChooseMessages}</p>
      {messages.map((m) => (
        <article key={m.id}>
          <label>
            <input
              type="checkbox"
              checked={selected.includes(m.id)}
              onChange={(e) =>
                onSelected(
                  e.target.checked
                    ? [...selected, m.id]
                    : selected.filter((id) => id !== m.id),
                )
              }
            />
            {m.author === "user" ? t.reviewUser : t.reviewAI} ·{" "}
            {t.reviewRequestVersion.replace(
              "{version}",
              String(m.requestVersion),
            )}
          </label>
          <p>{m.text}</p>
        </article>
      ))}
      {cursor && (
        <button type="button" onClick={() => load(cursor)}>
          {t.reviewMore}
        </button>
      )}
    </details>
  );
}
