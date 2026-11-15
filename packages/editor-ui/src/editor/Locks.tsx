import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { FinalizationState } from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { Autosave } from "./autosave";
import type en from "../locales/en.json";
import { ReviewCommands } from "./review-commands";
import { contentProtectionKey } from "./content-protection";
export function Locks({
  client,
  save,
  editor,
  projectId,
  t,
  headerTarget,
  onReady,
}: {
  client: PlatformClient;
  save: Autosave;
  editor: Editor | null;
  projectId: string;
  t: typeof en;
  headerTarget: Element | null;
  onReady: (ready: boolean) => void;
}) {
  const [state, setState] = useState<FinalizationState | null>(null),
    [error, setError] = useState(""),
    [queryError, setQueryError] = useState(false),
    [busy, setBusy] = useState(false),
    [positions, setPositions] = useState<Record<string, number>>({});
  const column = useRef<HTMLDivElement>(null),
    generation = useRef(0),
    [commands] = useState(() => new ReviewCommands(save));
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    try {
      const next = await client.readFinalization();
      if (n === generation.current) {
        setState(next);
        setQueryError(false);
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
    setBusy(true);
    setError("");
    try {
      let result = await commands.run(
        `lock:${blockId ?? "all"}:${locked}`,
        (revision) => ({
          type: "SetUserLocks",
          requestId: crypto.randomUUID(),
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
            requestId: crypto.randomUUID(),
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
      await refresh();
    } catch {
      setError("STORAGE_UNAVAILABLE");
    } finally {
      setBusy(false);
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
              disabled={!state || busy}
              onClick={() => void change(null, true)}
            >
              {t.lockAll}
            </button>
          </div>,
          headerTarget,
        )}
      <aside className="lock-column" aria-label={t.lockAll}>
        {(error || queryError) && (
          <p role="alert">
            {queryError ? t.lockUnavailable : t.lockPending}
            <code>{error}</code>
          </p>
        )}
        <div className="lock-controls" ref={column}>
          {save.state.blocks
            .filter((block) => positions[block.id] !== undefined)
            .map((block) => {
              const using = state?.reservedBlockIds.includes(block.id) ?? false;
              const locked =
                state?.locks.some((l) => l.blockId === block.id) ?? false;
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
                      ⌛
                    </span>
                  )}
                  <button
                    data-lock-block={block.id}
                    aria-label={locked ? t.unlock : t.lock}
                    aria-pressed={locked}
                    disabled={!state || busy}

                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void change(block.id, !locked)}
                  >
                    {locked ? "🔒" : "🔓"}
                  </button>
                </div>
              );
            })}
        </div>
      </aside>
    </>
  );
}
