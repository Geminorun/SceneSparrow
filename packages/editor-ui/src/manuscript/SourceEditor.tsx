import { useEffect, useRef, useState } from "react";
import {
  EditorState,
  Compartment,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  type DecorationSet,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  rawEditorMap,
  patchEditorSource,
  captureSourceSelection,
  sourceSelectionMap,
  sourcePresentation,
  sourceAcknowledgmentInsertions,
  sourceDifference,
  repairLiveSourceInput,
  sourceClipboardText,
} from "@scenesparrow/manuscript-format/editor-source";
import { readSourceDocument } from "@scenesparrow/manuscript-format/source";
import type {
  AuthoredSourceBinding,
  ReviewCard,
} from "@scenesparrow/contracts";
import type { ProjectSession } from "../project-session/project-session";
import type { ManuscriptSurface } from "./surface";
import type en from "../locales/en.json";
class DecodedText extends WidgetType {
  constructor(
    readonly text: string,
    readonly className = "",
  ) {
    super();
  }
  eq(other: DecodedText) {
    return other.text === this.text && other.className === this.className;
  }
  toDOM() {
    const node = document.createElement("span");
    node.className = `source-decoded-text ${this.className}`;
    node.textContent = this.text;
    return node;
  }
  ignoreEvent() {
    return false;
  }
}
const synchronize = StateEffect.define<boolean>();
const annotations = StateEffect.define<DecorationSet>();
const annotationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(annotations)) return effect.value;
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
export function localSourceBindings(
  save: ProjectSession,
): AuthoredSourceBinding[] {
  if (!save.source) return [];
  return readSourceDocument(save.sourceLocal).blocks.map((b) => ({
    address: b.address,
    kind: b.kind,
    startUtf8: b.startUtf8,
    endUtf8: b.endUtf8,
    id: b.id ?? null,
    listItemAddress: b.listItemAddress ?? null,
    semanticEditable: save.source!.bindings.some(
      (native) => native.id === b.id && native.semanticEditable,
    ),
  }));
}
export function SourceEditor({
  save,
  t,
  editable,
  onSurface,
}: {
  save: ProjectSession;
  t: typeof en;
  editable: boolean;
  onSurface: (surface: ManuscriptSurface | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    viewRef = useRef<EditorView | null>(null);
  const labelCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment()),
    presentationCompartment = useRef(new Compartment());
  const [sourceMode, setSourceMode] = useState(false);
  const modeRef = useRef(false);
  const presentationExtension = useRef<ReturnType<
    typeof EditorView.decorations.compute
  > | null>(null);
  const live = useRef({ t, onSurface });
  live.current = { t, onSurface };
  useEffect(() => {
    if (!host.current || !save.source) return;
    const listeners = {
      content: new Set<() => void>(),
      selection: new Set<() => void>(),
      viewport: new Set<() => void>(),
    };
    const emit = (event: keyof typeof listeners) => {
      for (const changed of listeners[event]) changed();
    };
    let selectionEpoch = 0;
    let protectedIds = new Set<string>();
    let cachedRaw: string | undefined,
      cachedSnapshot: ProjectSession["source"] = save.source,
      cachedBindings: AuthoredSourceBinding[] = [];
    let cachedBlocks = readSourceDocument(save.sourceLocal).blocks;
    let cachedMap = rawEditorMap(save.sourceLocal);
    let cachedById = new Map(
      cachedBlocks.flatMap((block) =>
        block.id ? [[block.id, block] as const] : [],
      ),
    );
    const bindings = () => {
      if (cachedRaw !== save.sourceLocal || cachedSnapshot !== save.source) {
        cachedRaw = save.sourceLocal;
        cachedSnapshot = save.source;
        cachedBindings = localSourceBindings(save);
        cachedBlocks = readSourceDocument(save.sourceLocal).blocks;
        cachedMap = rawEditorMap(save.sourceLocal);
        cachedById = new Map(
          cachedBlocks.flatMap((block) =>
            block.id ? [[block.id, block] as const] : [],
          ),
        );
      }
      return cachedBindings;
    };
    let selectionRaw: string | undefined,
      selectionState = save.state,
      selectionMap: ReturnType<typeof sourceSelectionMap> = [];
    const positions = () => {
      if (selectionRaw !== save.sourceLocal || selectionState !== save.state) {
        selectionRaw = save.sourceLocal;
        selectionState = save.state;
        selectionMap = sourceSelectionMap(
          save.sourceLocal,
          bindings(),
          save.state,
        );
      }
      return selectionMap;
    };
    let presentationDoc: EditorState["doc"] | null = null;
    let tokens: ReturnType<typeof sourcePresentation> = {
      hidden: [],
      replacements: [],
      marks: [],
    };
    const presentation = EditorView.decorations.compute(
      ["doc", "selection"],
      (state) => {
        if (state.doc !== presentationDoc) {
          presentationDoc = state.doc;
          tokens = sourcePresentation(state.doc.toString());
        }
        const active = state.selection.ranges.map((range) => ({
          from: state.doc.lineAt(range.from).from,
          to: state.doc.lineAt(range.to).to,
        }));
        const inactive = (from: number, to: number) =>
          !active.some(
            (range) => from <= range.to && Math.max(from, to - 1) >= range.from,
          );
        const ranges = [
          ...tokens.hidden
            .filter((range) => range.empty || inactive(range.from, range.to))
            .map((range) =>
              Decoration.replace({ block: range.block }).range(
                range.from,
                range.to,
              ),
            ),
          ...tokens.replacements
            .filter((range) => inactive(range.from, range.to))
            .map((range) =>
              Decoration.replace({
                widget: new DecodedText(range.text, range.className),
              }).range(range.from, range.to),
            ),
          ...tokens.marks.map((range) =>
            Decoration.mark({ class: range.className }).range(
              range.from,
              range.to,
            ),
          ),
        ];
        return Decoration.set(ranges, true);
      },
    );
    presentationExtension.current = presentation;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: rawEditorMap(save.sourceLocal).text,
        selection: {
          anchor: rawEditorMap(save.sourceLocal).editorAt(
            readSourceDocument(save.sourceLocal).blocks[0]?.startUtf16 ??
              (save.sourceLocal.startsWith("\uFEFF") ? 1 : 0),
          ),
        },
        extensions: [
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          annotationField,
          editableCompartment.current.of(EditorView.editable.of(editable)),
          presentationCompartment.current.of(presentation),
          labelCompartment.current.of(
            EditorView.contentAttributes.of({
              role: "textbox",
              "aria-multiline": "true",
              "aria-label": live.current.t.manuscript,
              spellcheck: "false",
            }),
          ),
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || tr.effects.some((e) => e.is(synchronize)))
              return tr;
            try {
              const changes: { from: number; to: number; insert: string }[] =
                [];
              tr.changes.iterChanges((from, to, _a, _b, insert) =>
                changes.push({ from, to, insert: insert.toString() }),
              );
              const proposed = patchEditorSource(save.sourceLocal, changes).raw;
              const repaired = modeRef.current
                ? { raw: proposed, cursorRaw: null }
                : repairLiveSourceInput(save.sourceLocal, changes);
              const proposedRaw = repaired.raw;
              if (protectedIds.size) {
                const before = readSourceDocument(save.sourceLocal),
                  after = readSourceDocument(proposedRaw);
                for (const id of protectedIds) {
                  const a = before.blocks.find((b) => b.id === id),
                    b = after.blocks.find((b) => b.id === id);
                  if (
                    !a ||
                    !b ||
                    a.kind !== b.kind ||
                    a.listItemAddress !== b.listItemAddress ||
                    save.sourceLocal.slice(a.startUtf16, a.endUtf16) !==
                      proposedRaw.slice(b.startUtf16, b.endUtf16)
                  )
                    return [];
                }
              }
              if (proposedRaw !== proposed) {
                const before = rawEditorMap(save.sourceLocal),
                  after = rawEditorMap(proposedRaw);
                return {
                  changes: sourceDifference(before.text, after.text).flat(),
                  selection:
                    repaired.cursorRaw === null
                      ? tr.newSelection
                      : { anchor: after.editorAt(repaired.cursorRaw) },
                  ...(tr.annotation(Transaction.userEvent)
                    ? { userEvent: tr.annotation(Transaction.userEvent)! }
                    : {}),
                };
              }
              return tr;
            } catch {
              return [];
            }
          }),
          EditorView.clipboardOutputFilter.of((_text, state) =>
            modeRef.current
              ? _text
              : state.selection.ranges
                  .map((range) =>
                    sourceClipboardText(
                      state.doc.toString(),
                      range.from,
                      range.to,
                    ),
                  )
                  .join("\n"),
          ),
          EditorView.clipboardInputFilter.of((text) =>
            modeRef.current ? text : sourceClipboardText(text),
          ),
          keymap.of([
            {
              key: "Mod-z",
              run: () => {
                void save.navigate("UndoProject", () => {});
                return true;
              },
            },
            {
              key: "Mod-Shift-z",
              run: () => {
                void save.navigate("RedoProject", () => {});
                return true;
              },
            },
            {
              key: "Mod-y",
              run: () => {
                void save.navigate("RedoProject", () => {});
                return true;
              },
            },
            ...defaultKeymap,
          ]),
          EditorView.domEventHandlers({
            compositionstart: () => {
              save.composition(true);
            },
            compositionend: () => {
              queueMicrotask(() => save.composition(false));
            },
            blur: () => {
              save.actions.blur("manuscript", () => save.composition(false));
              void save.boundary();
            },
          }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) =>
                tr.effects.some((e) => e.is(synchronize)),
              )
            ) {
              const changes: { from: number; to: number; insert: string }[] =
                [];
              update.changes.iterChanges((from, to, _a, _b, insert) =>
                changes.push({ from, to, insert: insert.toString() }),
              );
              save.updateSource(changes);
              emit("content");
            }
            if (update.selectionSet) {
              selectionEpoch++;
              emit("selection");
              if (!update.docChanged && !save.composing) void save.boundary();
            }
            if (update.viewportChanged) emit("viewport");
          }),
        ],
      }),
    });
    viewRef.current = view;
    const surface: ManuscriptSurface = {
      dom: view.dom,
      get empty() {
        return view.state.selection.main.empty;
      },
      get selectionIdentity() {
        return String(selectionEpoch);
      },
      capture(whole = false) {
        const map = rawEditorMap(save.sourceLocal),
          s = view.state.selection.main;
        return captureSourceSelection(
          save.sourceLocal,
          bindings(),
          save.state,
          map.rawAt(s.from),
          map.rawAt(s.to),
          whole,
        );
      },
      captureDocument() {
        return captureSourceSelection(
          save.sourceLocal,
          bindings(),
          save.state,
          0,
          save.sourceLocal.length,
          true,
          true,
        );
      },
      positions() {
        return positions().flatMap((p) =>
          p.block
            ? [{ block: p.block, pos: p.start!, size: p.end! - p.start! }]
            : [],
        );
      },
      blockRect(id) {
        try {
          bindings();
          const raw = cachedById.get(id);
          if (!raw) return null;
          const pos = cachedMap.editorAt(raw.startUtf16);
          const box = view.coordsAtPos(pos);
          return box
            ? DOMRect.fromRect({
                x: box.left,
                y: box.top,
                width: box.right - box.left,
                height: box.bottom - box.top,
              })
            : null;
        } catch {
          return null;
        }
      },
      visibleBlockRects() {
        try {
          bindings();
          const from = cachedMap.rawAt(view.viewport.from),
            to = cachedMap.rawAt(view.viewport.to);
          let low = 0,
            high = cachedBlocks.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (cachedBlocks[middle]!.endUtf16 < from) low = middle + 1;
            else high = middle;
          }
          const result: { id: string; rect: DOMRect }[] = [];
          for (let index = low; index < cachedBlocks.length; index++) {
            const block = cachedBlocks[index]!;
            if (block.startUtf16 > to) break;
            if (!block.id) continue;
            const rect = surface.blockRect(block.id);
            if (rect) result.push({ id: block.id, rect });
          }
          return result;
        } catch {
          return [];
        }
      },
      selectionRects() {
        const a = view.coordsAtPos(view.state.selection.main.from),
          b = view.coordsAtPos(view.state.selection.main.to);
        const rect = (r: typeof a) =>
          r
            ? DOMRect.fromRect({
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
              })
            : null;
        return a && b ? { start: rect(a)!, end: rect(b)! } : null;
      },
      scrollBlock(id) {
        bindings();
        const block = cachedBlocks.find((b) => b.id === id);
        if (block)
          view.dispatch({
            effects: EditorView.scrollIntoView(
              cachedMap.editorAt(block.startUtf16),
              { y: "center" },
            ),
          });
      },
      focus: () => view.focus(),
      subscribe(event, changed) {
        listeners[event].add(changed);
        return () => {
          listeners[event].delete(changed);
        };
      },
      protect(ids) {
        protectedIds = ids;
      },
      annotate(cards: ReviewCard[]) {
        const mapped = positions(),
          rawMap = rawEditorMap(save.sourceLocal),
          ranges = [];
        for (const card of cards)
          if (
            !card.thread.handled &&
            !card.thread.deleted &&
            card.thread.anchor.state === "mapped"
          )
            for (const range of card.thread.anchor.ranges) {
              const p = mapped.find((p) => p.block?.id === range.blockId);
              if (!p?.map || p.block?.revision !== range.revision) continue;
              const start = [...p.map].find(
                  ([, value]) => value === range.start,
                )?.[0],
                end = [...p.map]
                  .reverse()
                  .find(([, value]) => value === range.end)?.[0];
              if (start !== undefined && end !== undefined && end > start)
                ranges.push(
                  Decoration.mark({
                    class: "review-highlight",
                    attributes: { "data-review-thread": card.thread.id },
                  }).range(rawMap.editorAt(start), rawMap.editorAt(end)),
                );
            }
        view.dispatch({
          effects: annotations.of(Decoration.set(ranges, true)),
        });
      },
    };
    live.current.onSurface(surface);
    const stop = save.subscribeSource(() => {
      const next = rawEditorMap(save.sourceLocal).text,
        current = view.state.doc.toString();
      if (next === current || save.composing) return;
      try {
        const insertions = sourceAcknowledgmentInsertions(current, next);
        view.dispatch({
          changes: insertions
            .map((i) => ({ from: i.at, insert: i.text }))
            .sort((a, b) => a.from - b.from),
          effects: synchronize.of(true),
        });
      } catch {
        let from = 0;
        while (
          from < next.length &&
          from < current.length &&
          next[from] === current[from]
        )
          from++;
        let end = current.length,
          nextEnd = next.length;
        while (
          end > from &&
          nextEnd > from &&
          current[end - 1] === next[nextEnd - 1]
        ) {
          end--;
          nextEnd--;
        }
        view.dispatch({
          changes: { from, to: end, insert: next.slice(from, nextEnd) },
          effects: synchronize.of(true),
        });
      }
      emit("content");
    });
    return () => {
      stop();
      live.current.onSurface(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [save]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.current.reconfigure(
        EditorView.editable.of(editable),
      ),
    });
  }, [editable]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: labelCompartment.current.reconfigure(
        EditorView.contentAttributes.of({
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": t.manuscript,
          spellcheck: "false",
        }),
      ),
    });
  }, [t.manuscript]);
  const toggle = () => {
    modeRef.current = !sourceMode;
    setSourceMode((value) => !value);
    viewRef.current?.dispatch({
      effects: presentationCompartment.current.reconfigure(
        sourceMode ? presentationExtension.current! : [],
      ),
    });
  };
  return (
    <div className="source-manuscript">
      <button
        className="source-mode-toggle quiet-button"
        aria-pressed={sourceMode}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
      >
        {t.sourceMode}
      </button>
      <div ref={host} className="source-editor" data-testid="source-editor" />
    </div>
  );
}
