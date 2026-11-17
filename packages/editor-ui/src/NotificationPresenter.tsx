import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type en from "./locales/en.json";
import { notifications, notifyFailure, type Notice } from "./notifications";
import { trapDialogFocus } from "./dialog-focus";

export type SettingsSection = "general" | "services" | "defaults";
export const SettingsActions = createContext<
  (section: SettingsSection) => void
>(() => {});
export const useOpenSettings = () => useContext(SettingsActions);

/** Keep inline errors/recovery with their owner while sharing bounded global feedback. */
export function useErrorNotification(error: string | null | undefined) {
  useEffect(() => {
    if (error) notifyFailure(error);
  }, [error]);
}
export function useTaskNotifications(
  tasks: Array<{
    id: string;
    status: string;
    error?: string | null | undefined;
  }>,
  initialLoading = false,
) {
  const previous = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (initialLoading) {
      previous.current = null;
      return;
    }
    const old = previous.current;
    previous.current = new Map(
      tasks.map((task) => [task.id, `${task.status}:${task.error ?? ""}`]),
    );
    if (!old) return; // Reopening never replays historical failures.
    for (const task of tasks) {
      if (
        task.error &&
        ["failed", "interrupted", "stale"].includes(task.status) &&
        old.get(task.id) !== `${task.status}:${task.error}`
      )
        notifyFailure(task.error, {
          identity: `task:${task.id}:${task.status}:${task.error}`,
        });
    }
  }, [tasks, initialLoading]);
}
function NotificationItem({ notice, t }: { notice: Notice; t: typeof en }) {
  const openSettings = useOpenSettings();
  const previousFocus = useRef<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    notifications.hold(notice.id, hovered || focused);
    return () => notifications.hold(notice.id, false);
  }, [notice.id, hovered, focused]);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(
      () => notifications.dismiss(notice.id),
      Math.max(0, notice.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [notice.id, notice.expiresAt, hovered, focused]);
  const settingsSection =
    notice.key === "CONFIGURATION_UNAVAILABLE"
      ? "defaults"
      : notice.key === "CREDENTIAL_UNAVAILABLE"
        ? "services"
        : null;
  return (
    <div
      className="notification"
      data-tone={notice.tone}
      data-error-code={notice.key}
      data-testid={
        notice.key.startsWith("TRANSPORT_")
          ? "transport-failure"
          : "notification"
      }
      role={notice.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
      onFocusCapture={(event) => {
        setFocused(true);
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          event.relatedTarget instanceof HTMLElement
        )
          previousFocus.current = event.relatedTarget;
      }}
    >
      <div className="notification-content">
        <span>{t[notice.key]}</span>
        {(notice.status || notice.traceId || notice.target) && (
          <details>
            <summary>{t.notificationDetails}</summary>
            {notice.status && (
              <span>
                {t.notificationCoreHttp.replace(
                  "{status}",
                  String(notice.status),
                )}
              </span>
            )}
            {notice.traceId && (
              <span>
                {t.transportTrace.replace("{traceId}", notice.traceId)}
              </span>
            )}
            {notice.target && <code>{notice.target}</code>}
          </details>
        )}
      </div>
      {settingsSection && (
        <button
          className="quiet-button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            notifications.dismiss(notice.id);
            openSettings(settingsSection);
          }}
        >
          {t.notificationOpenSettings}
        </button>
      )}
      <button
        className="quiet-button notification-dismiss"
        aria-label={t.transportDismiss}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const restore = document.activeElement === event.currentTarget;
          notifications.dismiss(notice.id);
          if (restore && previousFocus.current?.isConnected)
            previousFocus.current.focus();
        }}
      >
        ×
      </button>
    </div>
  );
}
export function NotificationPresenter({ t }: { t: typeof en }) {
  const notices = useSyncExternalStore(
    notifications.subscribe,
    notifications.getSnapshot,
  );
  const [host, setHost] = useState<HTMLElement>(() => document.body);
  useEffect(() => {
    let sequence = 0;
    const order = new Map<HTMLDialogElement, number>();
    const update = (records: MutationRecord[] = []) => {
      if (
        records.length &&
        !records.some(
          (record) =>
            (record.type === "attributes" &&
              record.target instanceof HTMLDialogElement) ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches("dialog") || !!node.querySelector("dialog")),
            ),
        )
      )
        return;
      for (const record of records) {
        if (
          record.target instanceof HTMLDialogElement &&
          record.attributeName === "open"
        ) {
          if (record.target.open) order.set(record.target, ++sequence);
          else order.delete(record.target);
        }
      }
      const dialogs = [
        ...document.querySelectorAll<HTMLDialogElement>("dialog:modal"),
      ];
      for (const dialog of dialogs)
        if (!order.has(dialog)) order.set(dialog, ++sequence);
      for (const dialog of order.keys())
        if (!dialogs.includes(dialog)) order.delete(dialog);
      const active = dialogs
        .sort((a, b) => order.get(a)! - order.get(b)!)
        .at(-1);
      setHost(active ?? document.body);
    };
    // showModal enters the browser top layer; a body z-index cannot cross it.
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return createPortal(
    <section
      className="notifications"
      aria-label={t.notifications}
      aria-live="polite"
      aria-relevant="additions text"
      onKeyDown={(event) => {
        // Portal events follow the React tree, bypassing the native host's handler.
        if (host instanceof HTMLDialogElement) trapDialogFocus(event, host);
      }}
    >
      {notices.map((notice) => (
        <NotificationItem key={notice.id} notice={notice} t={t} />
      ))}
    </section>,
    host,
  );
}
