import { useNoticeOwner } from "../feedback/NotificationPresenter";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { FinalizationState } from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { ProjectSession } from "../project-session/project-session";
import type en from "../locales/en.json";
import type { TrackLocalLock } from "./local-lock-events";
import { ProjectCommands } from "../project-session/project-commands";
import { contentProtectionKey } from "../manuscript/content-protection";
export function Locks({
  client,
  save,
  editor,
  projectId,
  t,
  headerTarget,
  onReady,
  trackLock,
}: {
  client: PlatformClient;
  save: ProjectSession;
  editor: Editor | null;
  projectId: string;
  t: typeof en;
  headerTarget: Element | null;
  onReady: (ready: boolean) => void;
  trackLock: TrackLocalLock;
}) {
  const [state, setState] = useState<FinalizationState | null>(null),
    [error, setError] = useState(""),
    [queryError, setQueryError] = useState(false),
    [pending, setPending] = useState<string | null>(null),
    [positions, setPositions] = useState<Record<string, number>>({});
  const { report, resolve } = useNoticeOwner();
  useEffect(() => {
    if (error || queryError)
      report(error || "STORAGE_UNAVAILABLE", { identity: "locks" });
    else resolve("locks");
  }, [error, queryError, report, resolve]);
  const column = useRef<HTMLDivElement>(null),
    generation = useRef(0),
    [commands] = useState(() => new ProjectCommands(save));
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const next = await client.readFinalization();
      if (n === generation.current) {
        setState(next);
        setQueryError(false);
        return next;
      }
    } catch {
      if (n === generation.current) setQueryError(true);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const stop = client.subscribeEvents(
      (e) => {
        if (
          [
            "locks.changed",
            "manuscript.changed",
            "reviewTask.changed",
            "candidate.changed",
          ].includes(e.type)
        )
          void refresh();
      },
      () => void refresh(),
    );
    return () => {
      generation.current++;
      stop();
    };
  }, [client, refresh]);
  useEffect(() => {
    if (editor && state) {
      editor.view.dispatch(
        editor.state.tr.setMeta(
          contentProtectionKey,
          new Set([
            ...state.locks.map((l) => l.blockId),
            ...state.reservedBlockIds,
          ]),
        ),
      );
      editor.setEditable(true, false);
      onReady(true);
    }
  }, [editor, state, onReady]);
  useEffect(() => {
    if (!editor) return;
    let frame = 0;
    const nodes = new Map<string, Element>(),
      visible = new Set<string>();
    editor.view.dom.querySelectorAll("[data-blockid]").forEach((node) => {
      const id = node.getAttribute("data-blockid");
      if (id) nodes.set(id, node);
    });
    const measure = () => {
      frame = 0;
      if (!column.current) return;
      const top = column.current.getBoundingClientRect().top,
        next: Record<string, number> = {};
      for (const id of visible) {
        const node = nodes.get(id);
        if (node)
          next[id] = Math.max(0, node.getBoundingClientRect().top - top);
      }
      setPositions((prior) =>
        JSON.stringify(prior) === JSON.stringify(next) ? prior : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-blockid")!;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        schedule();
      },
      { rootMargin: "300px" },
    );
    const reconcile = () => {
      intersection.disconnect();
      nodes.clear();
      visible.clear();
      editor.view.dom.querySelectorAll("[data-blockid]").forEach((node) => {
        const id = node.getAttribute("data-blockid");
        if (id) {
          nodes.set(id, node);
          intersection.observe(node);
        }
      });
    };
    const mutations = new MutationObserver(reconcile);
    mutations.observe(editor.view.dom, { childList: true, subtree: true });
    for (const node of nodes.values()) intersection.observe(node);
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    editor.on("update", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      intersection.disconnect();
      editor.off("update", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      cancelAnimationFrame(frame);
    };
  }, [editor, save.canonicalVersion, save.state.blocks]);
  const change = async (blockId: string | null, locked: boolean) => {
    setPending(blockId ?? "all");
    setError("");
    let settleEvents: ReturnType<TrackLocalLock> | undefined;
    let confirmed: FinalizationState | undefined;
    const requestId = () => {
      settleEvents?.();
      const id = crypto.randomUUID();
      settleEvents = trackLock(projectId, id);
      return id;
    };
    try {
      let result = await commands.run(
        `lock:${blockId ?? "all"}:${locked}`,
        (revision) => ({
          type: "SetUserLocks",
          requestId: requestId(),
          projectId,
          expectedWorkingRevision: locked
            ? revision
            : (state?.workingRevision ?? revision),
          payload: {
            blockIds: blockId ? [blockId] : [],
            locked,
            all: !blockId,
          },
        }),
      );
      if (!result.ok && !locked && result.completed?.type === "SetUserLocks") {
        const latest = await client.readFinalization();
        result = await commands.run(
          `lock:${blockId ?? "all"}:${locked}`,
          () => ({
            type: "SetUserLocks",
            requestId: requestId(),
            projectId,
            expectedWorkingRevision: latest.workingRevision,
            payload: {
              blockIds: blockId ? [blockId] : [],
              locked: false,
              all: false,
            },
          }),
        );
      }
      if (!result.ok) setError(result.error || "PENDING_CANDIDATE");
      const receipt = save.businessReceipt;
      const next = await refresh();
      if (
        result.ok &&
        receipt &&
        result.completed?.requestId === receipt.requestId &&
        next?.workingRevision === receipt.receipt.workingRevision &&
        next.workingRevision === save.state.workingRevision
      )
        confirmed = next;
    } catch {
      setError("STORAGE_UNAVAILABLE");
    } finally {
      settleEvents?.(confirmed);
      setPending(null);
    }
  };
  return (
    <>
      {headerTarget &&
        createPortal(
          <div className="lock-column-heading">
            <span role="status">
              {!state
                ? t.connecting
                : state.finalized
                  ? t.finalized
                  : t.notFinalized}
            </span>
            <button
              disabled={!state || pending !== null}
              aria-busy={pending === "all" || undefined}
              aria-label={pending === "all" ? t.lockUpdating : t.lockAll}
              title={pending === "all" ? t.lockUpdating : t.lockAll}
              onClick={() => void change(null, true)}
            >
              <LockGlyph
                className="lock-all-icon"
                locked
                pending={pending === "all"}
              />
              <span className="lock-all-label">{t.lockAll}</span>
            </button>
          </div>,
          headerTarget,
        )}
      <aside className="lock-column" aria-label={t.lockAll}>
        <div className="lock-controls" ref={column}>
          {save.state.blocks
            .filter((block) => positions[block.id] !== undefined)
            .map((block) => {
              const using = state?.reservedBlockIds.includes(block.id) ?? false;
              const locked =
                state?.locks.some((l) => l.blockId === block.id) ?? false;
              const updating = pending === block.id;
              const label = updating
                ? t.lockUpdating
                : locked
                  ? t.unlock
                  : t.lock;
              return (
                <div
                  key={block.id}
                  className="block-lock-control"
                  style={{ top: positions[block.id] ?? 0 }}
                >
                  {using && (
                    <span
                      role="status"
                      aria-label={t.taskUsingContent}
                      title={t.taskUsingContent}
                    >
                      <svg
                        aria-hidden="true"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M7 3h10M7 21h10M8 3v5l8 8v5M16 3v5l-8 8v5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        />
                      </svg>
                    </span>
                  )}
                  <button
                    data-lock-block={block.id}
                    aria-label={label}
                    aria-pressed={locked}
                    aria-busy={updating || undefined}
                    disabled={!state || pending !== null}
                    title={label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void change(block.id, !locked)}
                  >
                    <LockGlyph locked={locked} pending={updating} />
                  </button>
                </div>
              );
            })}
        </div>
      </aside>
    </>
  );
}

function LockGlyph({
  className,
  locked,
  pending,
}: {
  className?: string;
  locked: boolean;
  pending: boolean;
}) {
  return (
    <svg
      className={[className, pending && "lock-pending-icon"]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      {pending ? (
        <path d="M12 4a8 8 0 1 1-8 8" />
      ) : (
        <>
          <rect
            x="5"
            y="10"
            width="14"
            height="11"
            rx="2"
            fill={locked ? "currentColor" : "none"}
          />
          <path
            d={locked ? "M8 10V7a4 4 0 0 1 8 0v3" : "M8 10V7a4 4 0 0 1 7.5-2"}
          />
          <path
            d="M12 14v3"
            stroke={locked ? "var(--canvas)" : "currentColor"}
          />
        </>
      )}
    </svg>
  );
}
