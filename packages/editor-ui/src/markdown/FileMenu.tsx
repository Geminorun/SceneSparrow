import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type en from "../locales/en.json";

type Action = { run: () => void; disabled?: boolean };

function menuItems(menu: HTMLElement | null) {
  return Array.from(
    menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:enabled') ??
      [],
  ).filter((item) => item.closest('[role="menu"]') === menu);
}

export function FileMenu({
  t,
  create,
  importFile,
  save,
  exportMarkdown,
  exportProject,
}: {
  t: typeof en;
  create: Action;
  importFile: Action;
  save: Action;
  exportMarkdown: Action;
  exportProject: Action & { savesFirst: boolean };
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const exportMenu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last" | "export">("first");
  const [panel, setPanel] = useState<"file" | "export" | null>(null);
  const open = panel !== null;
  const exporting = panel === "export";
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  useLayoutEffect(() => {
    if (!panel) return;
    if (initialFocus.current === "export") exportTrigger.current?.focus();
    else {
      const items = menuItems(
        panel === "export" ? exportMenu.current : menu.current,
      );
      items.at(initialFocus.current === "last" ? -1 : 0)?.focus();
    }
  }, [panel]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setPanel(null);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  function show(next: "file" | "export", focus: typeof initialFocus.current) {
    initialFocus.current = focus;
    setPanel(next);
  }

  function close() {
    setPanel(null);
    trigger.current?.focus();
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!save.disabled) {
        close();
        save.run();
      }
      return;
    }
    if (!open || event.ctrlKey || event.metaKey) return;
    const focused = event.target;
    if (!(focused instanceof HTMLButtonElement)) return;
    if (event.key === "Escape") close();
    else if (
      event.key === "Tab" &&
      event.shiftKey &&
      focused !== trigger.current
    )
      close();
    else if (event.key === "ArrowLeft" && exporting) show("file", "export");
    else if (event.key === "ArrowRight" && focused === exportTrigger.current)
      show("export", "first");
    else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      const items = menuItems(focused.closest('[role="menu"]'));
      if (!items.length) return;
      const index = items.indexOf(focused);
      if (event.key === "Home") items[0]?.focus();
      else if (event.key === "End") items.at(-1)?.focus();
      else {
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function item(action: Action, label: ReactNode, shortcut?: string) {
    return (
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        disabled={action.disabled}
        aria-keyshortcuts={shortcut}
        onClick={() => {
          close();
          action.run();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className="file-menu"
      ref={root}
      onKeyDown={navigate}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setPanel(null);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="quiet-button file-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? close() : show("file", "first"))}
        onKeyDown={(event) => {
          if (open || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          show("file", event.key === "ArrowUp" ? "last" : "first");
        }}
      >
        {t.markdownFileMenu}
      </button>
      <div
        ref={menu}
        id={id}
        className="file-menu-popup"
        role="menu"
        aria-label={t.markdownFileMenu}
        hidden={!open}
      >
        {item(create, t.markdownNew)}
        {item(importFile, t.markdownImport)}
        <div role="separator" />
        {item(
          save,
          <>
            {t.markdownSave}
            <kbd aria-hidden="true">{apple ? "⌘S" : "Ctrl+S"}</kbd>
          </>,
          apple ? "Meta+S" : "Control+S",
        )}
        <div className="file-menu-export" role="none">
          <button
            type="button"
            ref={exportTrigger}
            role="menuitem"
            tabIndex={-1}
            aria-haspopup="menu"
            aria-controls={`${id}-export`}
            aria-expanded={exporting}
            disabled={exportMarkdown.disabled && exportProject.disabled}
            onClick={() =>
              exporting ? show("file", "export") : show("export", "first")
            }
          >
            {t.markdownExport}
            <span className="file-menu-chevron" aria-hidden="true" />
          </button>
          <div
            ref={exportMenu}
            id={`${id}-export`}
            className="file-menu-popup file-menu-formats"
            role="menu"
            aria-label={t.markdownExport}
            hidden={!exporting}
          >
            {item(exportMarkdown, "Markdown")}
            {item(
              exportProject,
              exportProject.savesFirst
                ? t.markdownSaveExportProject
                : t.markdownExportProject,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
