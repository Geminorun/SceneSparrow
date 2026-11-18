import type en from "../locales/en.json";

export function warningMessage(code: string, t: typeof en) {
  if (code === "IMAGES_UNPROCESSED") return t.imagesUnprocessed;
  if (code.startsWith("PDF_")) return t.pdfLayoutWarning;
  if (code === "RAW_HTML_IGNORED") return t.rawHtmlIgnored;
  return t.formatNormalized;
}
