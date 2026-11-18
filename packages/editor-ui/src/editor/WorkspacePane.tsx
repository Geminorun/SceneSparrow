import { useEffect, useRef, useState, type ReactNode } from "react";
import type en from "../locales/en.json";
import { WorkspaceIcon } from "../WorkspaceIcon";

export type AuxiliaryTab = "structure" | "planning" | "review" | "sources";
type Side = "left" | "right";
const groups: Record<Side, AuxiliaryTab[]> = {
  left: ["structure", "sources"],
  right: ["planning", "review"],
};
const media = "(max-width: 1050px)";
const bounds = { left: [200, 360, 240], right: [280, 520, 340] } as const;
export function useAuxiliaryPane() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(media).matches);
  const [preferences, setPreferences] = useState(() => {
    let saved: any = {},
      legacy: any = {};
    try {
      saved = JSON.parse(
        localStorage.getItem("scenesparrow.workspace-panes") ?? "{}",
      );
      legacy = JSON.parse(
        localStorage.getItem("scenesparrow.auxiliary") ?? "{}",
      );
    } catch {
      /* Invalid UI preferences are disposable. */
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
      legacy = {};
    const read = (side: Side) => ({
      tab: (groups[side].includes(saved[side]?.tab)
        ? saved[side].tab
        : groups[side].includes(legacy.tab)
          ? legacy.tab
          : groups[side][0]) as AuxiliaryTab,
      collapsed:
        typeof saved[side]?.collapsed === "boolean"
          ? saved[side].collapsed
          : window.matchMedia(media).matches ||
            (groups[side].includes(legacy.tab) && legacy.collapsed === true),
      width: Math.min(
        bounds[side][1],
        Math.max(
          bounds[side][0],
          Number(saved[side]?.width) ||
            (side === "right" ? Number(legacy.width) : 0) ||
            bounds[side][2],
        ),
      ),
    });
    return { left: read("left"), right: read("right") };
  });
  const [drawer, setDrawer] = useState<Side | null>(null);
  useEffect(() => {
    const query = window.matchMedia(media);
    const update = () => {
      setNarrow(query.matches);
      setDrawer(null);
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        "scenesparrow.workspace-panes",
        JSON.stringify(preferences),
      );
    } catch {
      // Optional layout preferences never own project content.
    }
  }, [preferences]);
  return {
    ...preferences,
    narrow,
    drawer,
    visible: (side: Side) =>
      narrow ? drawer === side : !preferences[side].collapsed,
    open: (tab: AuxiliaryTab) => {
      const side = groups.left.includes(tab) ? "left" : "right";
      setPreferences((p) => ({
        ...p,
        [side]: { ...p[side], tab, collapsed: false },
      }));
      if (narrow) setDrawer(side);
    },
    collapse: (side: Side = "right") => {
      setPreferences((p) => ({
        ...p,
        [side]: { ...p[side], collapsed: true },
      }));
      setDrawer(null);
    },
    resize: (side: Side, width: number) =>
      setPreferences((p) => ({
        ...p,
        [side]: {
          ...p[side],
          width: Math.min(bounds[side][1], Math.max(bounds[side][0], width)),
        },
      })),
  };
}
export function WorkspacePane({
  pane,
  t,
  children,
  panels,
  rightContent,
}: {
  pane: ReturnType<typeof useAuxiliaryPane>;
  t: typeof en;
  children: ReactNode;
  panels: Record<AuxiliaryTab, ReactNode>;
  rightContent?: ReactNode;
}) {
  const buttons = useRef<
    Partial<Record<AuxiliaryTab, HTMLButtonElement | null>>
  >({});
  const openers = useRef<Partial<Record<Side, HTMLButtonElement | null>>>({});
  const panes = useRef<Partial<Record<Side, HTMLElement | null>>>({});
  const previousFocus = useRef<HTMLElement | null>(null);
  const close = (side: Side) => {
    pane.collapse(side);
    requestAnimationFrame(() =>
      (previousFocus.current?.isConnected &&
      !previousFocus.current.closest(".auxiliary-pane")
        ? previousFocus.current
        : openers.current[side]
      )?.focus(),
    );
  };
  const open = (side: Side) => {
    previousFocus.current = document.activeElement as HTMLElement;
    pane.open(pane[side].tab);
    requestAnimationFrame(() => buttons.current[pane[side].tab]?.focus());
  };
  useEffect(() => {
    if (!pane.narrow || !pane.drawer) return;
    const side = pane.drawer;
    const frame = requestAnimationFrame(() => {
      if (!panes.current[side]?.contains(document.activeElement))
        buttons.current[pane[side].tab]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pane.narrow, pane.drawer]);
  const renderPane = (side: Side) => {
    const visible = pane.visible(side),
      tabs = groups[side],
      selected = pane[side].tab;
    return (
      <aside
        ref={(node) => {
          panes.current[side] = node;
        }}
        className={`auxiliary-pane ${side}-pane`}
        hidden={!visible}
        aria-label={
          side === "left" ? t.workspaceNavigator : t.workspaceAssistant
        }
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !(event.target as Element).closest("[role=dialog]")
          ) {
            event.preventDefault();
            event.stopPropagation();
            close(side);
          }
          if (pane.narrow && event.key === "Tab") {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
              ),
            ].filter(
              (node) =>
                node.getClientRects().length && !node.closest("[hidden]"),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="auxiliary-heading">
          <div
            role="tablist"
            aria-label={
              side === "left" ? t.workspaceNavigator : t.workspaceAssistant
            }
            onKeyDown={(event) => {
              const index = tabs.indexOf(selected);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : -1;
              if (next < 0) return;
              event.preventDefault();
              pane.open(tabs[next]!);
              buttons.current[tabs[next]!]?.focus();
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab}
                ref={(node) => {
                  buttons.current[tab] = node;
                }}
                id={`auxiliary-tab-${tab}`}
                role="tab"
                aria-selected={selected === tab}
                aria-controls={`auxiliary-${tab}`}
                tabIndex={selected === tab ? 0 : -1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const fromPane = panes.current[side]?.contains(
                    document.activeElement,
                  );
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
            aria-label={
              side === "left"
                ? t.workspaceCloseNavigator
                : t.workspaceClosePanel
            }
            onClick={() => close(side)}
          >
            <WorkspaceIcon name="close" />
          </button>
        </div>
        {side === "right" && rightContent
          ? rightContent
          : tabs.map((tab) => (
              <section
                className="auxiliary-content"
                key={tab}
                id={`auxiliary-${tab}`}
                role="tabpanel"
                aria-labelledby={`auxiliary-tab-${tab}`}
                hidden={selected !== tab}
                inert={selected !== tab}
              >
                {panels[tab]}
              </section>
            ))}
      </aside>
    );
  };
  const resizer = (side: Side) => (
    <div
      className={`auxiliary-resizer ${side}-resizer`}
      hidden={!pane.visible(side) || pane.narrow}
      role="separator"
      aria-label={
        side === "left" ? t.workspaceResizeNavigator : t.workspaceResizePanel
      }
      aria-orientation="vertical"
      aria-valuemin={bounds[side][0]}
      aria-valuemax={bounds[side][1]}
      aria-valuenow={pane[side].width}
      tabIndex={0}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        pane.resize(
          side,
          event.key === "Home"
            ? bounds[side][0]
            : event.key === "End"
              ? bounds[side][1]
              : pane[side].width +
                (event.key === "ArrowRight" ? 16 : -16) *
                  (side === "left" ? 1 : -1),
        );
      }}
      onPointerDown={(event) =>
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          const rect =
            event.currentTarget.parentElement!.getBoundingClientRect();
          pane.resize(
            side,
            side === "left"
              ? event.clientX - rect.left
              : rect.right - event.clientX,
          );
        }
      }}
      onPointerUp={(event) =>
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    />
  );
  return (
    <div
      data-layout={pane.narrow ? "drawer" : "split"}
      className={`editor-workspace-grid ${!pane.visible("left") ? "navigator-collapsed" : ""} ${!pane.visible("right") ? "auxiliary-collapsed" : ""}`}
      style={
        {
          "--navigator-width": `${pane.left.width}px`,
          "--auxiliary-width": `${pane.right.width}px`,
        } as React.CSSProperties
      }
    >
      {renderPane("left")}
      {resizer("left")}
      <div
        className="manuscript-main"
        inert={pane.narrow && pane.drawer !== null}
      >
        {children}
      </div>
      {resizer("right")}
      {renderPane("right")}
      {(["left", "right"] as const).map((side) => (
        <button
          key={side}
          className={`auxiliary-toggle ${side}-toggle quiet-button`}
          ref={(node) => {
            openers.current[side] = node;
          }}
          aria-label={
            side === "left" ? t.workspaceOpenNavigator : t.workspaceOpenPanel
          }
          aria-expanded={pane.visible(side)}
          onClick={() => open(side)}
          hidden={pane.visible(side)}
          inert={pane.narrow && pane.drawer !== null}
        >
          <WorkspaceIcon name={side === "left" ? "panelLeft" : "panelRight"} />
        </button>
      ))}
    </div>
  );
}
