import { useEffect, useRef, useState, type ReactNode } from "react";
import type en from "../locales/en.json";

export type AuxiliaryTab = "structure" | "planning" | "review" | "sources";
const tabs: AuxiliaryTab[] = ["structure", "planning", "review", "sources"];
const storageKey = "scenesparrow.auxiliary";
export function useAuxiliaryPane() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia("(max-width: 900px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      return {
        tab: (tabs.includes(saved.tab)
          ? saved.tab
          : "structure") as AuxiliaryTab,
        collapsed:
          typeof saved.collapsed === "boolean"
            ? saved.collapsed
            : window.matchMedia("(max-width: 900px)").matches,
        width: Math.min(520, Math.max(280, Number(saved.width) || 320)),
      };
    } catch {
      return { tab: "structure" as AuxiliaryTab, collapsed: false, width: 320 };
    }
  });
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  }, [preferences]);
  return {
    ...preferences,
    narrow,
    open: (tab: AuxiliaryTab) =>
      setPreferences((p) => ({ ...p, tab, collapsed: false })),
    collapse: () => setPreferences((p) => ({ ...p, collapsed: true })),
    resize: (width: number) =>
      setPreferences((p) => ({
        ...p,
        width: Math.min(520, Math.max(280, width)),
      })),
  };
}
export function WorkspacePane({
  pane,
  t,
  children,
  panels,
}: {
  pane: ReturnType<typeof useAuxiliaryPane>;
  t: typeof en;
  children: ReactNode;
  panels: Record<AuxiliaryTab, ReactNode>;
}) {
  const buttons = useRef<
    Partial<Record<AuxiliaryTab, HTMLButtonElement | null>>
  >({});
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    pane.collapse();
    requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <div
      className={`editor-workspace-grid ${pane.collapsed ? "auxiliary-collapsed" : ""}`}
      style={{ "--auxiliary-width": `${pane.width}px` } as React.CSSProperties}
    >
      <div className="manuscript-main" inert={pane.narrow && !pane.collapsed}>
        {children}
      </div>
      <button
        className="auxiliary-toggle quiet-button"
        ref={opener}
        aria-label={t.workspaceOpenPanel}
        aria-expanded={!pane.collapsed}
        onClick={() => {
          pane.open(pane.tab);
          requestAnimationFrame(() => buttons.current[pane.tab]?.focus());
        }}
        hidden={!pane.collapsed}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
          <path
            d="M4 4h16v16H4zM15 4v16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>
      <div
        className="auxiliary-resizer"
        hidden={pane.collapsed}
        role="separator"
        aria-label={t.workspaceResizePanel}
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={520}
        aria-valuenow={pane.width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          pane.resize(
            event.key === "Home"
              ? 280
              : event.key === "End"
                ? 520
                : pane.width + (event.key === "ArrowLeft" ? 16 : -16),
          );
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            pane.resize(
              event.currentTarget.parentElement!.getBoundingClientRect().right -
                event.clientX,
            );
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <aside
        className="auxiliary-pane"
        hidden={pane.collapsed}
        aria-label={t.workspacePanel}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !(event.target as Element).closest("[role=dialog]")
          ) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <div className="auxiliary-heading">
          <div
            role="tablist"
            aria-label={t.workspacePanel}
            onKeyDown={(event) => {
              const index = tabs.indexOf(pane.tab);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 3
                    : event.key === "ArrowRight"
                      ? (index + 1) % 4
                      : event.key === "ArrowLeft"
                        ? (index + 3) % 4
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              pane.open(tabs[next]!);
              buttons.current[tabs[next]!]?.focus();
            }}
          >
            {tabs.map((tab) => (
              <button
                ref={(node) => {
                  buttons.current[tab] = node;
                }}
                key={tab}
                id={`auxiliary-tab-${tab}`}
                role="tab"
                aria-selected={pane.tab === tab}
                aria-controls={`auxiliary-${tab}`}
                tabIndex={pane.tab === tab ? 0 : -1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const fromPane =
                    !!document.activeElement?.closest(".auxiliary-pane");
                  pane.open(tab);
                  if (fromPane) buttons.current[tab]?.focus();
                }}
              >
                {t[`workspaceTab_${tab}`]}
              </button>
            ))}
          </div>
          <button
            className="quiet-button pane-close"
            aria-label={t.workspaceClosePanel}
            onClick={close}
          >
            ×
          </button>
        </div>
        {tabs.map((tab) => (
          <section
            className="auxiliary-content"
            key={tab}
            id={`auxiliary-${tab}`}
            role="tabpanel"
            aria-labelledby={`auxiliary-tab-${tab}`}
            hidden={pane.tab !== tab}
          >
            {panels[tab]}
          </section>
        ))}
      </aside>
    </div>
  );
}
