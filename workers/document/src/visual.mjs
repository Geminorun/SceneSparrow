import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readDocx, ParseError } from "./parser.mjs";
const fail = (code) => {
  throw new ParseError(code);
};
// One explicit 1-based embedded image or PDF page. Never fetch remote resources.
export async function prepareVisual(bytes, name, index) {
  if (
    bytes.length > 25 * 1024 * 1024 ||
    !Number.isSafeInteger(index) ||
    index < 1
  )
    fail("INVALID_REQUEST");
  let canvas, transformation;
  if (/\.docx$/i.test(name)) {
    const entries = await readDocx(bytes, true);
    const names = [...entries.keys()]
      .filter((n) => /^word\/media\/[^/]+\.(png|jpe?g|webp)$/i.test(n))
      .sort();
    const selected = entries.get(names[index - 1]);
    if (!selected) fail("OBJECT_NOT_FOUND");
    if (selected.length > 4 * 1024 * 1024) fail("DOCUMENT_RESOURCE_LIMIT");
    const png = selected
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      selected[0] === 255 && selected[1] === 216 && selected[2] === 255;
    const webp =
      selected.subarray(0, 4).toString() === "RIFF" &&
      selected.subarray(8, 12).toString() === "WEBP";
    const mediaName = names[index - 1];
    if (!(
      (png && /\.png$/i.test(mediaName)) ||
      (jpeg && /\.jpe?g$/i.test(mediaName)) ||
      (webp && /\.webp$/i.test(mediaName))
    ))
      fail("SOURCE_UNSUPPORTED");
    const image = await loadImage(selected);
    if (
      !image.width ||
      !image.height ||
      image.width > 32768 ||
      image.height > 32768
    )
      fail("DOCUMENT_RESOURCE_LIMIT");
    const scale = Math.min(1, 4096 / image.width, 4096 / image.height);
    canvas = createCanvas(
      Math.max(1, Math.floor(image.width * scale)),
      Math.max(1, Math.floor(image.height * scale)),
    );
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    transformation = `docx:${names[index - 1]};original:${image.width}x${image.height};png;scale:${scale}`;
  } else if (/\.pdf$/i.test(name)) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: true,
    }).promise;
    try {
      if (index > document.numPages) fail("OBJECT_NOT_FOUND");
      const page = await document.getPage(index);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 4096 / original.width, 4096 / original.height);
      const viewport = page.getViewport({ scale });
      canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      await page.render({ canvasContext: canvas.getContext("2d"), viewport })
        .promise;
      transformation = `pdf:page:${index};original:${original.width}x${original.height};png;scale:${scale}`;
    } finally {
      await document.destroy();
    }
  } else fail("SOURCE_UNSUPPORTED");
  const png = await canvas.encode("png");
  if (png.length > 4 * 1024 * 1024) fail("DOCUMENT_RESOURCE_LIMIT");
  return {
    data: png.toString("base64"),
    width: canvas.width,
    height: canvas.height,
    transformation,
  };
}
