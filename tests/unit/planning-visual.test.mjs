import test from "node:test";
import assert from "node:assert/strict";
import { prepareVisual } from "../../workers/document/src/visual.mjs";
import { docx, pdf } from "../fixtures/documents.mjs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../workers/document/package.json", import.meta.url),
);
const { createCanvas, loadImage } = require("@napi-rs/canvas");
test("selected DOCX image and PDF page are actual bounded PNG pixels with provenance", async () => {
  const image = createCanvas(12, 8);
  const ctx = image.getContext("2d");
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, 12, 8);
  const png = await image.encode("png");
  const prepared = await prepareVisual(
    docx("<w:p/>", { "word/media/image1.png": png }),
    "fixture.docx",
    1,
  );
  assert.equal(prepared.width, 12);
  assert.equal(prepared.height, 8);
  assert.match(prepared.transformation, /word\/media\/image1.png/);
  const decoded = await loadImage(Buffer.from(prepared.data, "base64"));
  const canvas = createCanvas(12, 8);
  canvas.getContext("2d").drawImage(decoded, 0, 0);
  assert.deepEqual(
    [...canvas.getContext("2d").getImageData(2, 2, 1, 1).data],
    [255, 0, 0, 255],
  );
  const page = await prepareVisual(pdf([{ image: true }]), "scanned.pdf", 1);
  assert.equal(page.width, 600);
  assert.equal(page.height, 600);
  assert.match(page.transformation, /pdf:page:1/);
  assert.ok(
    Buffer.from(page.data, "base64")
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  await assert.rejects(
    prepareVisual(
      docx("<w:p/>", {
        "word/media/image1.png": Buffer.from(
          '<svg width="10" height="10"></svg>',
        ),
      }),
      "mislabeled.docx",
      1,
    ),
    (e) => e.code === "SOURCE_UNSUPPORTED",
  );
  await assert.rejects(
    prepareVisual(pdf(), "page.pdf", 2),
    (e) => e.code === "OBJECT_NOT_FOUND",
  );
});
