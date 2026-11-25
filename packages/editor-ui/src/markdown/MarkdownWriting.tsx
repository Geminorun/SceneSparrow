import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import type { CompositionActions } from "../project-session/composition-actions";

export type WritingCapture = {
  projectId: string;
  revision: string;
  text: string;
  epoch: number;
  session: object;
  outline?:
    | {
        session: object;
        text: string;
        revision: string | null;
        epoch: number;
      }
    | undefined;
};
export type WritingDraft = {
  capture: WritingCapture;
  text: string;
  conflict?: boolean;
};
export function MarkdownWriting({
  client,
  t,
  capture,
  onOutline,
  onDraft,
  composition,
  outline,
  validate,
}: {
  client: PlatformClient;
  t: typeof en;
  capture: (kind: "outline" | "draft") => Promise<WritingCapture>;
  onOutline: (result: WritingDraft) => Promise<void>;
  onDraft: (draft: WritingDraft) => void;
  composition: CompositionActions;
  outline: string | null;
  validate: (capture: WritingCapture) => void;
}) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [retainedOutline, setRetainedOutline] = useState<string | null>(null);
  const actionKey = useRef(`writing:${crypto.randomUUID()}`).current;
  const active = useRef(true);
  const running = useRef(false);
  const briefInput = useRef(brief);
  const notice = useNoticeOwner();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      composition.cancel(actionKey);
      composition.composition(`${actionKey}:brief`, false);
    };
  }, []);
  async function generate(kind: "outline" | "draft") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await composition.run(actionKey, async () => {
        if (!active.current) return;
        const input = briefInput.current;
        const context = await capture(kind);
        if (!active.current) return;
        if (
          kind === "outline" &&
          context.outline?.text.trim() &&
          !window.confirm(t.markdownReplaceOutlineConfirm)
        )
          return;
        const [settings, ready] = await Promise.all([
          client.readAiSettings(),
          client.resolveAiConfiguration(),
        ]);
        if (!active.current) return;
        validate(context);
        const result = await client.markdownProjects!.write(context.projectId, {
          actionId: crypto.randomUUID(),
          sessionId: settings.sessionId,
          fingerprint: ready.configuration.fingerprint,
          kind,
          brief: input,
          outline: context.outline?.text ?? "",
          text: context.text,
          revision: context.revision,
          ...(kind === "draft"
            ? { outlineRevision: context.outline!.revision! }
            : {}),
        });
        if (!active.current) return;
        const candidate = { capture: context, text: result.text };
        if (kind === "draft") onDraft(candidate);
        else {
          try {
            await onOutline(candidate);
            if (active.current) setRetainedOutline(null);
          } catch (failure) {
            if (active.current) setRetainedOutline(result.text);
            throw failure;
          }
        }
      });
    } catch (failure) {
      if (active.current) notice.report(failure);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      className="assistant-panel markdown-writing"
      aria-label={t.markdownAiWriting}
    >
      <p>{t.markdownWritingSession}</p>
      <label>
        {t.markdownWritingBrief}
        <textarea
          value={brief}
          maxLength={16384}
          onChange={(event) => {
            briefInput.current = event.currentTarget.value;
            setBrief(event.currentTarget.value);
          }}
          onCompositionStart={() =>
            composition.composition(`${actionKey}:brief`, true)
          }
          onCompositionEnd={() =>
            composition.composition(`${actionKey}:brief`, false)
          }
          onBlur={() =>
            composition.blur(`${actionKey}:brief`, () =>
              composition.composition(`${actionKey}:brief`, false),
            )
          }
        />
      </label>
      <button
        disabled={busy || outline === null || !brief.trim()}
        onClick={() => void generate("outline")}
      >
        {outline?.trim()
          ? t.markdownRegenerateOutline
          : t.markdownGenerateOutline}
      </button>
      <button
        disabled={busy || !outline?.trim()}
        onClick={() => void generate("draft")}
      >
        {t.markdownGenerateDraft}
      </button>
      {busy && <p role="status">{t.markdownWritingProgress}</p>}
      {retainedOutline !== null && (
        <details className="markdown-retained-outline">
          <summary>{t.markdownRetainedOutline}</summary>
          <pre>{retainedOutline}</pre>
        </details>
      )}
    </section>
  );
}
