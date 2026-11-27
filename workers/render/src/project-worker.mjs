import { join } from "node:path";
import {
  snapshot,
  loadProjectSkill,
  validateComposition,
  template,
} from "./video-project.mjs";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16 * 1024)
    throw Error("VIDEO_REQUEST_INVALID");
}
try {
  const request = JSON.parse(input);
  if (
    request.version !== 1 ||
    !["snapshot", "render"].includes(request.operation)
  )
    throw Error("VIDEO_REQUEST_INVALID");
  validateComposition(request.composition);
  await snapshot(request.directory, request.composition);
  const loaded = await loadProjectSkill(request.directory);
  if (request.operation === "render") {
    const { bundle } = await import("@remotion/bundler");
    const { ensureBrowser, selectComposition, renderMedia } =
      await import("@remotion/renderer");
    const browser = await ensureBrowser({
      chromeMode: "headless-shell",
      browserExecutable: process.env.SCENESPARROW_RENDER_BROWSER,
      logLevel: "error",
      onBrowserDownload() {
        throw Error("VIDEO_RENDER_UNAVAILABLE");
      },
    });
    if (!("path" in browser)) throw Error("VIDEO_RENDER_UNAVAILABLE");
    // Only this shipped entry is executable. Agent changes are validated JSON props.
    const serveUrl = await bundle({
      entryPoint: join(template, "src/index.ts"),
      enableCaching: false,
      publicDir: join(template, "public"),
      onProgress() {},
      logLevel: "error",
    });
    const inputProps = request.composition;
    const composition = await selectComposition({
      serveUrl,
      id: "MotionSample",
      browserExecutable: browser.path,
      logLevel: "error",
      inputProps,
    });
    await renderMedia({
      composition,
      serveUrl,
      inputProps,
      codec: "h264",
      outputLocation: join(request.directory, "video.mp4"),
      concurrency: 1,
      browserExecutable: browser.path,
      timeoutInMilliseconds: 30000,
      logLevel: "error",
    });
  }
  process.stdout.write(JSON.stringify({ version: 1, ...loaded }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      error: /^VIDEO_[A-Z_]+$/.test(error.message)
        ? error.message
        : "VIDEO_WORKER_FAILED",
    }),
  );
  process.exitCode = 1;
}
