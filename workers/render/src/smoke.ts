import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";

const root = new URL("../../../", import.meta.url);
const output = fileURLToPath(new URL(".artifacts/render/smoke.mp4", root));
await mkdir(fileURLToPath(new URL(".artifacts/render/", root)), {
  recursive: true,
});
const browser = await ensureBrowser({ chromeMode: "headless-shell" });
if (!("path" in browser)) throw new Error("Rendering browser is unavailable");
const serveUrl = await bundle({
  entryPoint: fileURLToPath(new URL("entry.tsx", import.meta.url)),
});
const composition = await selectComposition({
  serveUrl,
  id: "MotionSample",
  browserExecutable: browser.path,
});
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: output,
  concurrency: 2,
  browserExecutable: browser.path,
});
console.log(`Rendered ${composition.durationInFrames} frames to ${output}`);
