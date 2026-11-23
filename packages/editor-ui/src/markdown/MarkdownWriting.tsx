import { useEffect, useRef, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
import type { CompositionActions } from "../project-session/composition-actions";
import { MarkdownPreview } from "./MarkdownPreview";

export type WritingCapture = {
  projectId: string;
  revision: string;
  text: string;
  epoch: number;
  session: object;
};
export type WritingDraft = { capture: WritingCapture; text: string };
export function MarkdownWriting({
  client,
  t,
  capture,
  onDraft,
  composition,
  onClose,
}: {
  client: PlatformClient;
  t: typeof en;
  capture: () => WritingCapture;
  onDraft: (draft: WritingDraft) => void;
  composition: CompositionActions;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [outline, setOutline] = useState("");
  const [generated, setGenerated] = useState("");
  const [busy, setBusy] = useState(false);
  const actionKey = useRef(`writing:${crypto.randomUUID()}`).current;
  const active = useRef(true);
  const running = useRef(false);
  const inputs = useRef({ brief, outline, outlineEpoch: 0 });
  const notice = useNoticeOwner();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      composition.cancel(actionKey);
      composition.composition(`${actionKey}:brief`, false);
      composition.composition(`${actionKey}:outline`, false);
    };
  }, []);
  async function generate(kind: "outline" | "draft") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await composition.run(actionKey, async () => {
        if (!active.current) return;
        const context = capture();
        const input = { ...inputs.current };
        const [settings, ready] = await Promise.all([
          client.readAiSettings(),
          client.resolveAiConfiguration(),
        ]);
        if (!active.current) return;
        const result = await client.markdownProjects!.write(context.projectId, {
          actionId: crypto.randomUUID(),
          sessionId: settings.sessionId,
          fingerprint: ready.configuration.fingerprint,
          kind,
          brief: input.brief,
          outline: input.outline,
          text: context.text,
          revision: context.revision,
        });
        if (!active.current) return;
        if (kind === "draft") onDraft({ capture: context, text: result.text });
        else {
          setGenerated(result.text);
          if (inputs.current.outlineEpoch === input.outlineEpoch) {
            inputs.current.outline = result.text;
            setOutline(result.text);
          } else notice.report("MARKDOWN_OUTLINE_CHANGED");
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
    <aside className="markdown-writing" aria-label={t.markdownAiWriting}>
      <div className="dialog-heading">
        <h2>{t.markdownAiWriting}</h2>
        <button onClick={onClose}>{t.close}</button>
      </div>
      <p>{t.markdownWritingSession}</p>
      <label>
        {t.markdownWritingBrief}
        <textarea
          value={brief}
          maxLength={16384}
          onChange={(event) => {
            inputs.current.brief = event.currentTarget.value;
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
        disabled={busy || !brief.trim()}
        onClick={() => void generate("outline")}
      >
        {t.markdownGenerateOutline}
      </button>
      {generated && <MarkdownPreview text={generated} />}
      <label>
        {t.markdownWritingOutline}
        <textarea
          value={outline}
          maxLength={262144}
          onChange={(event) => {
            inputs.current.outline = event.currentTarget.value;
            inputs.current.outlineEpoch++;
            setOutline(event.currentTarget.value);
          }}
          onCompositionStart={() =>
            composition.composition(`${actionKey}:outline`, true)
          }
          onCompositionEnd={() =>
            composition.composition(`${actionKey}:outline`, false)
          }
          onBlur={() =>
            composition.blur(`${actionKey}:outline`, () =>
              composition.composition(`${actionKey}:outline`, false),
            )
          }
        />
      </label>
      {generated && generated !== outline && (
        <button
          onClick={() => {
            inputs.current.outline = generated;
            inputs.current.outlineEpoch++;
            setOutline(generated);
          }}
        >
          {t.markdownUseOutline}
        </button>
      )}
      <button
        disabled={busy || !brief.trim() || !outline.trim()}
        onClick={() => void generate("draft")}
      >
        {t.markdownGenerateDraft}
      </button>
      {busy && <p role="status">{t.markdownWritingProgress}</p>}
    </aside>
  );
}
