import { useEffect, useRef, type ReactNode } from "react";
import { trapDialogFocus } from "./dialog-focus";

export function WritingDialog({
  title,
  close,
  closeLabel,
  closeDisabled = false,
  children,
  returnFocus,
}: {
  title: string;
  close: () => void;
  closeLabel: string;
  closeDisabled?: boolean;
  children: ReactNode;
  returnFocus?: HTMLElement | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    node?.showModal();
    return () => {
      node?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      className="writing-dialog"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) close();
      }}
      onKeyDown={(event) => {
        if (dialog.current) trapDialogFocus(event, dialog.current);
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          aria-label={closeLabel}
          disabled={closeDisabled}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="writing-dialog-body">{children}</div>
    </dialog>
  );
}
