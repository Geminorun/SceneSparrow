// Explicit process-cold/OS-cache-warm evidence; never part of ordinary unit tests.
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
const directory = resolve(process.argv[2]);
const binary = resolve(
  process.env.SCENESPARROW_CORE_BIN ?? "target/release/scenesparrow-service",
);
const samples = [];
let expected;
for (
  let n = 0;
  n < Number(process.env.SCENESPARROW_REOPEN_SAMPLES ?? 20);
  n++
) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const token = randomBytes(32).toString("hex"),
    started = performance.now();
  const child = spawn(binary, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      SCENESPARROW_PROJECT_DIR: directory,
      SCENESPARROW_CORE_PORT: String(port),
      SCENESPARROW_SESSION_TOKEN: token,
    },
  });
  const req = async (path) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    for (;;) {
      try {
        await req("/health");
        break;
      } catch {
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          performance.now() - started > 20000
        )
          throw Error("Cold core failed");
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    const healthMs = performance.now() - started;
    const body = await req("/manuscript"),
      history = await req("/history"),
      reviews = await req("/reviews"),
      exports = await req("/manuscript/exports");
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          blocks: body.blocks,
          history,
          reviews,
          exports: exports.map((j) => ({
            id: j.id,
            artifactHash: j.artifactHash,
          })),
        }),
      )
      .digest("hex");
    if (expected) assert.equal(identity, expected);
    else expected = identity;
    const status = await readFile(`/proc/${child.pid}/status`, "utf8");
    samples.push({
      healthMs,
      readMs: performance.now() - started,
      coreRssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0),
      blockCount: body.blocks.length,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGINT");
      await ended;
    }
  }
}
const disk = {};
for (const name of ["objects", "exports", "staging"]) {
  let files = 0,
    bytes = 0;
  for (const item of await readdir(join(directory, name))) {
    const meta = await stat(join(directory, name, item));
    if (meta.isFile()) {
      files++;
      bytes += meta.size;
    }
  }
  disk[name] = { files, bytes };
}
for (const name of ["project.sqlite", "project.sqlite-wal"]) {
  try {
    disk[name] = (await stat(join(directory, name))).size;
  } catch {}
}
const report = {
  build: {
    binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    profile: process.env.SCENESPARROW_CORE_PROFILE ?? "release",
  },
  method:
    "new core process each sample; existing OS page cache; 5ms health polling; no provider requests",
  identity: expected,
  samples,
  disk,
  node: process.version,
  hardware: execFileSync("uname", ["-srmo"], { encoding: "utf8" }).trim(),
};
await mkdir(".artifacts", { recursive: true });
await writeFile(
  ".artifacts/step-08-cold-reopen.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
