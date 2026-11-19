/** B's intake names are safe basenames of at most 120 UTF-8 bytes. Keep whole
 * graphemes so CJK/emoji filenames remain valid on both browser and native hosts. */
export function safePackageFilename(input) {
  const name = (input.split(/[\\/]/).at(-1) ?? "").replace(
    /["\u0000-\u001f\u007f]/g,
    "_",
  );
  const encoder = new TextEncoder();
  let result = "",
    length = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(name)) {
    const bytes = encoder.encode(segment).length;
    if (length + bytes > 120) break;
    result += segment;
    length += bytes;
  }
  return result || "project.zip";
}
