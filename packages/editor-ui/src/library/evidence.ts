import type {
  PlanningEvidenceChoice,
  SourceSummary,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";

export type PlanningEvidenceBridge = {
  choices: PlanningEvidenceChoice[];
  locked: boolean;
  update: (sourceId: string, choice: PlanningEvidenceChoice | null) => void;
};
export const evidenceTextLimit = 128 * 1024;
/** Stop at a valid character boundary; extraction offsets are UTF-8, DOM selections UTF-16. */
export function textRange(text: string, start = 0, end = text.length) {
  const empty = end <= start;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
  if (empty) end = start;
  if (!empty && end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? ""))
    end++;
  return {
    start: new TextEncoder().encode(text.slice(0, start)).length,
    end: new TextEncoder().encode(text.slice(0, end)).length,
  };
}
export async function readEvidenceText(
  client: Pick<PlatformClient, "extractionPage">,
  jobId: string,
) {
  let text = "",
    offset = 0;
  for (let pages = 0; pages < 256; pages++) {
    const page = await client.extractionPage(jobId, offset);
    if (page.offset !== offset) throw new Error("SOURCE_TEXT_UNAVAILABLE");
    text += page.text;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > evidenceTextLimit) {
      let end = evidenceTextLimit;
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.slice(0, end),
      );
      return { text, truncated: true };
    }
    if (page.next === null) return { text, truncated: false };
    if (page.next <= offset) throw new Error("SOURCE_TEXT_UNAVAILABLE");
    offset = page.next;
  }
  throw new Error("DOCUMENT_RESOURCE_LIMIT");
}
export function evidenceChoice(
  item: SourceSummary,
  text = "",
): PlanningEvidenceChoice {
  return {
    sourceId: item.source.id,
    mode:
      item.source.kind === "link"
        ? "link_only"
        : item.hasImages
          ? "text_only"
          : "extracted_text",
    ...textRange(text),
    visualId: "",
    allowUnknownImages: false,
  };
}
