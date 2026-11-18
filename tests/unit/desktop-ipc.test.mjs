import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAiIpc } from "../../apps/desktop/src/ai-ipc.ts";
import { registerExportIpc } from "../../apps/desktop/src/export-ipc.ts";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const event = {};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gate = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function fixture(register, overrides = {}) {
  const handlers = new Map(),
    calls = [],
    checks = [];
  let session = {
    core: {},
    baseUrl: "http://127.0.0.1:4318/v1",
    token: "first",
  };
  const lifecycle = register(
    { handle: (name, handler) => handlers.set(name, handler) },
    {
      checkSender(value, existing) {
        checks.push(existing);
        if (value !== event) throw Error("ORIGIN_DENIED");
      },
      request: async (...args) => {
        calls.push(args);
        return { ok: true, data: {} };
      },
      session: () => session,
      fetch: async (...args) => {
        calls.push(args);
        return new Response(new Uint8Array([1]));
      },
      chooseFile: async () => {
        calls.push("choose");
        return null;
      },
      writeClipboard: () => calls.push("clipboard"),
      ...overrides,
    },
  );
  return {
    handlers,
    calls,
    checks,
    lifecycle,
    call: (channel, ...args) => handlers.get(channel)(event, ...args),
    switchSession() {
      session = { ...session, core: {}, token: "next" };
    },
  };
}

test("AI and export IPC deny untrusted senders before any host side effect", async () => {
  for (const register of [registerAiIpc, registerExportIpc]) {
    const f = fixture(register);
    for (const handler of f.handlers.values())
      await assert.rejects(
        Promise.resolve().then(() => handler({}, id, {})),
        /ORIGIN_DENIED/,
      );
    assert.deepEqual(f.calls, []);
  }
});

test("AI IPC keeps named routes, methods, invalid IDs and fresh bounded result authentication", async () => {
  let response = new Response(new Uint8Array(8388608));
  const downloads = [];
  const f = fixture(registerAiIpc, {
    fetch: async (url, options) => {
      downloads.push([url, options.headers.Authorization]);
      assert.ok(options.signal instanceof AbortSignal);
      return response;
    },
  });
  const routes = [
    ["ai:settings-read", "/ai/settings", "GET"],
    ["ai:settings-update", "/ai/settings", "PUT"],
    ["ai:credential-update", "/ai/credentials", "POST"],
    ["ai:credential-delete", "/ai/credentials/delete", "POST"],
    ["ai:configuration", "/ai/configuration", "GET"],
    ["ai:models", "/ai/models/discover", "POST"],
    ["ai:test-prepare", "/ai/connection-tests/prepare", "POST"],
    ["ai:test", "/ai/connection-tests", "POST"],
    ["ai:run", `/ai/runs/${id}`, "GET"],
    ["ai:cancel", `/ai/runs/${id}/cancel`, "POST"],
  ];
  assert.deepEqual(
    [...f.handlers.keys()].sort(),
    [...routes.map(([channel]) => channel), "ai:result"].sort(),
  );
  for (const [channel, path, method] of routes) {
    const value =
      channel === "ai:run" || channel === "ai:cancel" ? id : { setting: true };
    await f.call(channel, value);
    assert.deepEqual(f.calls.pop(), [
      path,
      method === "GET" || channel === "ai:cancel" ? undefined : value,
      method,
    ]);
  }
  for (const channel of ["ai:run", "ai:cancel", "ai:result"])
    assert.deepEqual(await f.call(channel, "../../settings"), {
      ok: false,
      code: "INVALID_REQUEST",
    });
  assert.equal(downloads.length, 0);
  assert.equal((await f.call("ai:result", id)).data.length, 8388608);
  f.switchSession();
  response = new Response(new Uint8Array(8388609));
  assert.deepEqual(await f.call("ai:result", id), {
    ok: false,
    code: "OUTPUT_TRUNCATED",
  });
  assert.deepEqual(downloads, [
    [`http://127.0.0.1:4318/v1/ai/runs/${id}/result`, "Bearer first"],
    [`http://127.0.0.1:4318/v1/ai/runs/${id}/result`, "Bearer next"],
  ]);
  for (const [body, code] of [
    [{ code: "OBJECT_NOT_FOUND" }, "OBJECT_NOT_FOUND"],
    [{}, "RESULT_UNAVAILABLE"],
  ]) {
    response = Response.json(body, { status: 404 });
    assert.deepEqual(await f.call("ai:result", id), { ok: false, code });
  }
});

test("export IPC keeps closed routes and native action validation envelopes", async () => {
  const f = fixture(registerExportIpc);
  assert.deepEqual(
    [...f.handlers.keys()].sort(),
    [
      "export:start",
      "export:job",
      "export:cancel",
      "export:retry",
      "export:bytes",
      "export:list",
      "copy:prepare",
      "export:clipboard",
      "export:save",
    ].sort(),
  );
  const body = { requestId: id };
  for (const [channel, args, expected] of [
    ["export:start", [body], ["/manuscript/exports", body]],
    ["export:job", [id], [`/manuscript/exports/${id}`, undefined]],
    ["export:cancel", [id, body], [`/manuscript/exports/${id}/cancel`, body]],
    ["export:retry", [id, body], [`/manuscript/exports/${id}/retry`, body]],
    ["export:list", [], ["/manuscript/exports"]],
    ["copy:prepare", [body], ["/manuscript/copies", body]],
  ]) {
    await f.call(channel, ...args);
    assert.deepEqual(f.calls.pop(), expected);
  }
  for (const channel of [
    "export:job",
    "export:cancel",
    "export:retry",
    "export:bytes",
    "export:save",
  ])
    assert.deepEqual(await f.call(channel, "../../artifact"), {
      ok: false,
      code: "INVALID_REQUEST",
    });
  assert.deepEqual(
    await f.call("export:save", {
      deliveryId: id,
      jobId: id,
      artifactHash: "a".repeat(64),
      path: "/tmp/target",
    }),
    { ok: false, code: "INVALID_REQUEST" },
  );
  assert.deepEqual(
    await f.call("export:clipboard", {
      deliveryId: id,
      preparationId: id,
      bodyHash: "invalid",
    }),
    { ok: false, code: "CLIPBOARD_UNAVAILABLE" },
  );
  assert.deepEqual(f.calls, []);
});

test("export artifact bytes preserve readiness, hash and size checks with current authentication", async () => {
  let bytes = new Uint8Array([1, 2]),
    job = { status: "ready", artifactHash: hash(bytes) };
  let failure;
  const downloads = [];
  const f = fixture(registerExportIpc, {
    request: async () => failure ?? { ok: true, data: job },
    fetch: async (url, options) => {
      downloads.push([url, options.headers.Authorization]);
      return new Response(bytes);
    },
  });
  assert.deepEqual(await f.call("export:bytes", id), { ok: true, data: bytes });
  f.switchSession();
  job = { ...job, artifactHash: "0".repeat(64) };
  assert.equal((await f.call("export:bytes", id)).code, "ARTIFACT_MISMATCH");
  assert.equal(downloads.at(-1)[1], "Bearer next");
  assert.equal(
    downloads[0][0],
    `http://127.0.0.1:4318/v1/manuscript/exports/${id}/artifact`,
  );
  bytes = new Uint8Array(32 * 1024 * 1024 + 1);
  job.artifactHash = hash(bytes);
  assert.equal((await f.call("export:bytes", id)).code, "ARTIFACT_MISMATCH");
  job.status = "running";
  assert.equal((await f.call("export:bytes", id)).code, "ARTIFACT_MISMATCH");
  assert.equal(downloads.length, 3);
  failure = { ok: false, code: "OBJECT_NOT_FOUND" };
  assert.deepEqual(await f.call("export:bytes", id), failure);
});

test("export lifecycle waits for save and copy, fences stale ownership, and clears replay state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-ipc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const choosing = gate(),
    chosen = gate(),
    copying = gate(),
    reading = gate();
  const bytes = new Uint8Array([1]),
    artifactHash = hash(bytes);
  const requests = [],
    writes = [];
  const f = fixture(registerExportIpc, {
    request: async (path, body) => {
      requests.push(path);
      if (path === `/manuscript/copies/${id}`) {
        reading.resolve();
        await copying.promise;
        return { ok: true, data: { text: "body", bodyHash: artifactHash } };
      }
      if (path === `/manuscript/exports/${id}`)
        return {
          ok: true,
          data: { status: "ready", artifactHash, format: "txt" },
        };
      return { ok: true, data: { ...body, status: "intent" } };
    },
    fetch: async () => new Response(bytes),
    chooseFile: async () => {
      chosen.resolve();
      await choosing.promise;
      return join(directory, "target.txt");
    },
    writeClipboard: (text) => writes.push(text),
  });
  const saveAction = { deliveryId: id, jobId: id, artifactHash };
  const copyAction = {
    deliveryId: otherId,
    preparationId: id,
    bodyHash: artifactHash,
  };
  const saving = f.call("export:save", saveAction),
    duplicate = f.call("export:save", saveAction);
  const copy = f.call("export:clipboard", copyAction);
  await Promise.all([chosen.promise, reading.promise]);
  let settled = false;
  const waiting = f.lifecycle.settled().then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  f.switchSession();
  choosing.resolve();
  assert.deepEqual(await saving, { ok: false, code: "CAPABILITY_EXPIRED" });
  assert.deepEqual(await duplicate, await saving);
  assert.equal(settled, false);
  copying.resolve();
  assert.deepEqual(await copy, { ok: false, code: "CLIPBOARD_UNAVAILABLE" });
  await waiting;
  assert.equal(settled, true);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(writes, []);
  assert.ok(f.checks.includes(true));
  assert.equal(
    requests.filter((path) => path === "/manuscript/deliveries").length,
    1,
  );
  assert.equal((await f.call("export:clipboard", copyAction)).ok, false);
  f.lifecycle.clear();
  assert.equal((await f.call("export:clipboard", copyAction)).ok, true);
  assert.equal((await f.call("export:clipboard", copyAction)).ok, true);
  assert.deepEqual(writes, ["body"]);
  await f.call("export:save", saveAction);
  assert.equal(
    requests.filter((path) => path === "/manuscript/deliveries").length,
    2,
  );
  await f.lifecycle.settled();
});
