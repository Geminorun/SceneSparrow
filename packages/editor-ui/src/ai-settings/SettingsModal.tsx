import { useEffect, useId, useRef, type ReactNode } from "react";
import type en from "../locales/en.json";
export function SettingsModal({
  title,
  t,
  onClose,
  children,
}: {
  title: string;
  t: typeof en;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const current = dialog.current;
    current?.showModal();
    return () => {
      current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="ai-picker-dialog"
      aria-labelledby={titleId}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="dialog-heading">
        <h3 id={titleId}>{title}</h3>
        <button className="quiet-button" onClick={onClose}>
          {t.close}
        </button>
      </div>
      {children}
    </dialog>
  );
}
