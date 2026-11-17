import { useEffect, useId, useRef, type ReactNode } from "react";
import type en from "../locales/en.json";
import { trapDialogFocus } from "../dialog-focus";
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
        trapDialogFocus(event, event.currentTarget);
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
