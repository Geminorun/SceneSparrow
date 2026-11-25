import type { MarkdownDocumentKind } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { ExchangeComparison } from "./ExchangeComparison";

export function ExchangeReview({
  documents,
  t,
  applying,
  apply,
  saveSeparate,
  separateBusy,
  separateProject,
}: {
  documents: {
    kind: MarkdownDocumentKind;
    text: string;
    current: string;
    conflict: string | null;
  }[];
  t: typeof en;
  applying: boolean;
  apply: (kind: MarkdownDocumentKind) => void;
  saveSeparate: () => void;
  separateBusy: boolean;
  separateProject: string | null;
}) {
  return (
    <>
      {!documents.length && <p>{t.markdownExchangeUnchanged}</p>}
      {documents.map((document) => (
        <section
          key={document.kind}
          aria-label={
            document.kind === "outline" ? t.writingOutline : t.manuscript
          }
        >
          <h3>
            {document.kind === "outline" ? t.writingOutline : t.manuscript}
          </h3>
          {document.conflict && (
            <p className="markdown-conflict">
              {document.conflict === "MARKDOWN_CONFLICT" ||
              document.conflict === "MARKDOWN_EXCHANGE_CONFLICT"
                ? t.MARKDOWN_EXCHANGE_CONFLICT
                : (t[document.conflict as keyof typeof t] ??
                  t.MARKDOWN_EXCHANGE_CONFLICT)}
            </p>
          )}
          <ExchangeComparison
            current={document.current}
            returned={document.text}
            t={t}
          />
          <button
            disabled={applying || !!document.conflict}
            onClick={() => apply(document.kind)}
          >
            {t.markdownApplyChanges}
          </button>
          {document.kind === "manuscript" && (
            <>
              <button disabled={separateBusy} onClick={saveSeparate}>
                {t.markdownSaveReturned}
              </button>
              {separateProject && (
                <a
                  href={separateProject}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t.markdownOpenReturned}
                </a>
              )}
            </>
          )}
        </section>
      ))}
    </>
  );
}
