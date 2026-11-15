import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import { CanonicalIdentity } from "./identity";
import { Extension } from "@tiptap/core";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { ManuscriptState } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { Autosave } from "./autosave";
import { fromEditor, toEditor } from "./canonical";
// Project history is introduced in step 2; local editor undo must not claim durability.
const NoLocalHistory = Extension.create({
  name: "noLocalHistory",
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => true,
      "Mod-Shift-z": () => true,
      "Mod-y": () => true,
    };
  },
});
export function Manuscript({
  client,
  projectId,
  t,
  onRevision,
}: {
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
}) {
  const [initial, setInitial] = useState<ManuscriptState | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let active = true;
    void client.readManuscript().then(
      (s) => {
        if (active) setInitial(s);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, projectId]);
  if (loadError)
    return (
      <p role="alert">
        {t.error}
        <button
          onClick={() => {
            setLoadError(false);
            void client
              .readManuscript()
              .then(setInitial, () => setLoadError(true));
          }}
        >
          {t.retry}
        </button>
      </p>
    );
  if (!initial) return <p role="status">{t.connecting}</p>;
  return (
    <Draft
      initial={initial}
      client={client}
      projectId={projectId}
      t={t}
      onRevision={onRevision}
    />
  );
}
function Draft({
  initial,
  client,
  projectId,
  t,
  onRevision,
}: {
  initial: ManuscriptState;
  client: PlatformClient;
  projectId: string;
  t: typeof en;
  onRevision: (revision: number) => void;
}) {
  const [, render] = useState(0);
  const [recovery, setRecovery] = useState(false);
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [save] = useState(
    () => new Autosave(initial, projectId, client, () => render((n) => n + 1)),
  );
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        code: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        trailingNode: false,
        link: {
          openOnClick: false,
          protocols: ["http", "https", "mailto"],
          isAllowedUri: (url) => /^(https?:\/\/|mailto:)/i.test(url),
        },
      }),
      Code.extend({ excludes: "" }),
      CanonicalIdentity.configure({
        attributeName: "blockId",
        types: ["paragraph", "heading"],
      }),
      NoLocalHistory,
    ],
    content: toEditor(initial.blocks),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t.manuscript,
      },
      handleDOMEvents: {
        compositionstart: () => {
          save.composition(true);
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            if (editor) {
              try {
                save.update(
                  fromEditor(
                    editor.getJSON(),
                    new Set(save.state.blocks.map((b) => b.id)),
                  ),
                );
              } catch (error) {
                save.invalidate(
                  error instanceof Error ? error.message : "DOCUMENT_INVALID",
                  editor.getText({ blockSeparator: "\n" }),
                );
              }
            }
            save.composition(false);
          });
          return false;
        },
        blur: () => {
          void save.flush();
          return false;
        },
      },
    },
    onUpdate: ({ editor }) => {
      try {
        save.update(
          fromEditor(
            editor.getJSON(),
            new Set(save.state.blocks.map((b) => b.id)),
          ),
        );
      } catch (error) {
        save.invalidate(
          error instanceof Error ? error.message : "DOCUMENT_INVALID",
          editor.getText({ blockSeparator: "\n" }),
        );
      }
    },
  });
  const closeDecision = useRef<((allowed: boolean) => void) | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    onRevision(save.state.workingRevision);
  }, [save.state.workingRevision, onRevision]);
  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => {
      if (save.status !== "saved") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warning);
    const remove = client.onCloseRequested?.(async () => {
      const ok = await save.flush();
      if (ok) return true;
      setRecovery(true);
      setClosing(true);
      return new Promise<boolean>((resolve) => {
        closeDecision.current = resolve;
      });
    });
    return () => {
      closeDecision.current?.(false);
      closeDecision.current = null;
      save.dispose();
      remove?.();
      window.removeEventListener("beforeunload", warning);
    };
  }, [client, save]);
  async function reload() {
    if (await save.reload()) {
      editor?.commands.setContent(toEditor(save.state.blocks), {
        emitUpdate: false,
      });
      setRecovery(false);
      setClosing(false);
      // The user explicitly chose to discard local input; finish the close handshake.
      closeDecision.current?.(true);
      closeDecision.current = null;
    }
  }
  const headings = save.local.filter((b) => b.kind === "heading");
  const toolbar = (action: () => unknown) => {
    action();
    editor?.commands.focus();
  };
  return (
    <section className="manuscript-workspace">
      <div className="manuscript-header">
        <h3>{t.manuscript}</h3>
        <span role="status" data-testid="save-status" data-state={save.status}>
          {t[`save_${save.status}`]}
        </span>
      </div>
      {save.state.workspaceStage === "outline" ? (
        <div className="document-start">
          <p>{t.startDescription}</p>
          <button
            disabled={save.status === "saving"}
            onClick={() => void save.start()}
          >
            {t.startWriting}
          </button>
        </div>
      ) : (
        <>
          <div
            className="editor-toolbar"
            role="toolbar"
            aria-label={t.formatting}
          >
            <select
              aria-label={t.blockStyle}
              value=""
              onChange={(e) =>
                toolbar(() =>
                  e.target.value === "paragraph"
                    ? editor?.chain().focus().setParagraph().run()
                    : editor
                        ?.chain()
                        .focus()
                        .setHeading({
                          level: Number(e.target.value) as
                            1 | 2 | 3 | 4 | 5 | 6,
                        })
                        .run(),
                )
              }
            >
              <option value="" disabled>
                {t.blockStyle}
              </option>
              <option value="paragraph">{t.paragraph}</option>
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {t.heading} {n}
                </option>
              ))}
            </select>
            <button
              aria-label={t.bold}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().toggleBold().run())
              }
            >
              <strong>B</strong>
            </button>
            <button
              aria-label={t.italic}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().toggleItalic().run())
              }
            >
              <em>I</em>
            </button>
            <button
              aria-label={t.inlineCode}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().toggleCode().run())
              }
            >
              {"</>"}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().toggleBulletList().run())
              }
            >
              {t.bulletList}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().toggleOrderedList().run())
              }
            >
              {t.orderedList}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setLink(String(editor?.getAttributes("link").href ?? ""));
                setLinkOpen(!linkOpen);
              }}
            >
              {t.link}
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                toolbar(() => editor?.chain().focus().unsetLink().run())
              }
            >
              {t.removeLink}
            </button>
          </div>
          {linkOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (/^(https?:\/\/|mailto:)/i.test(link)) {
                  editor
                    ?.chain()
                    .focus()
                    .extendMarkRange("link")
                    .setLink({ href: link })
                    .run();
                  setLinkOpen(false);
                }
              }}
            >
              <label>
                {t.linkUrl}
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  required
                  pattern="(https?://|mailto:).*"
                />
              </label>
              <button type="submit">{t.applyLink}</button>
            </form>
          )}
          <div className="document-layout">
            <nav aria-label={t.headings}>
              {headings.length ? (
                headings.map((b) => (
                  <button
                    key={b.id}
                    style={{
                      paddingInlineStart: `${(b.attrs.level ?? 1) * 8}px`,
                    }}
                    onClick={() =>
                      editor?.view.dom
                        .querySelector(`[data-blockid="${b.id}"]`)
                        ?.scrollIntoView({
                          block: "center",
                          behavior: "smooth",
                        })
                    }
                  >
                    {b.runs.map((r) => r.text).join("") || t.heading}
                  </button>
                ))
              ) : (
                <p className="muted">{t.noHeadings}</p>
              )}
            </nav>
            <EditorContent editor={editor} />
          </div>
        </>
      )}
      {(save.status === "error" || save.status === "conflict") && (
        <div role="alert" className="error">
          <p>
            {save.status === "conflict" ? t.conflictHelp : t.saveErrorHelp}{" "}
            <span data-testid="save-error-code" data-error-code={save.error}>
              {save.error === "DOCUMENT_TOO_LARGE"
                ? t.documentTooLarge
                : save.error === "DOCUMENT_INVALID"
                  ? t.documentInvalid
                  : ""}
            </span>
          </p>
          {save.status !== "conflict" && (
            <button onClick={() => void save.flush(true)}>{t.retry}</button>
          )}
          <button onClick={() => setRecovery(true)}>{t.recover}</button>
        </div>
      )}
      {recovery && (
        <div className="recovery" role="dialog" aria-label={t.recover}>
          <p>{t.recoveryHelp}</p>
          <textarea
            aria-label={t.localCopy}
            readOnly
            value={
              save.recoveryText ??
              save.local
                .map((b) => b.runs.map((r) => r.text).join(""))
                .join("\n")
            }
          />
          <button onClick={() => void reload()}>{t.discardAndReload}</button>
          <button
            onClick={() => {
              setRecovery(false);
              setClosing(false);
              closeDecision.current?.(false);
              closeDecision.current = null;
            }}
          >
            {t.keepEditing}
          </button>
          {closing && (
            <>
              <button
                onClick={() =>
                  void save.flush(true).then((ok) => {
                    if (ok) {
                      setClosing(false);
                      closeDecision.current?.(true);
                      closeDecision.current = null;
                    }
                  })
                }
              >
                {t.retryClose}
              </button>
              <button
                onClick={() => {
                  closeDecision.current?.(true);
                  closeDecision.current = null;
                }}
              >
                {t.closeUnsaved}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
