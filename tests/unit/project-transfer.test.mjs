import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHttpClient } from "../../packages/platform-client/src/http.ts";
import { createDesktopClient } from "../../packages/platform-client/src/desktop.ts";
import { registerProjectTransferIpc } from "../../apps/desktop/src/project-transfer-ipc.ts";
import { serializeMigrationMarkdown } from "../../packages/manuscript-format/src/migration.ts";
import { readSourceDocument } from "../../packages/manuscript-format/src/source.ts";
const request = {
  requestId: randomUUID(),
  projectId: randomUUID(),
  targetId: randomUUID(),
  contentBase: "a".repeat(64),
};
const control = {
  requestId: randomUUID(),
  projectId: request.projectId,
  operationId: request.requestId,
  expectedOperationRevision: 3,
  action: "cancel",
};
const methods = [
  "inspectLegacyMigration",
  "issueMigrationTarget",
  "startLegacyMigration",
  "readMigrationOperation",
  "controlMigration",
];
test("migration serializer preserves explicit empty/nested identities and escapes hostile spelling", () => {
  const blocks = [
    { id: randomUUID(), kind: "paragraph", attrs: {}, runs: [] },
    {
      id: randomUUID(),
      kind: "list_item",
      attrs: { depth: 0, listKind: "bullet" },
      runs: [],
    },
    {
      id: randomUUID(),
      kind: "list_item",
      attrs: { depth: 1, listKind: "ordered" },
      runs: [{ text: "Unicode 🐦\nsecond **literal**", marks: [] }],
    },
  ];
  const source = serializeMigrationMarkdown(blocks);
  assert.deepEqual(
    readSourceDocument(
      source,
      blocks.map((b) => b.id),
    ).blocks.map((b) => b.id),
    blocks.map((b) => b.id),
  );
  assert.match(source, /scenesparrow:empty=/);
  assert.equal(serializeMigrationMarkdown(blocks), source);
});
test("trusted migration worker and legacy export remain bare-Node importable", () => {
  const blocks = [
    {
      id: randomUUID(),
      kind: "paragraph",
      attrs: {},
      runs: [{ text: "hello 🐦", marks: [] }],
    },
  ];
  const worker = spawnSync(
    process.execPath,
    ["workers/document/src/migration-entry.mjs"],
    {
      input: JSON.stringify(blocks),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: "--this-is-not-a-valid-node-option",
      },
    },
  );
  // Native document_command clears NODE_OPTIONS; this direct subprocess uses a
  // clean explicit environment to verify the independent bare-Node module seam.
  const clean = spawnSync(
    process.execPath,
    ["workers/document/src/migration-entry.mjs"],
    {
      input: JSON.stringify(blocks),
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  assert.notEqual(worker.status, 0);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(JSON.parse(clean.stdout).source, /hello 🐦/);
  const old = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { markdown } from "./workers/document/src/export.mjs"; process.stdout.write(markdown({version:1,blocks:[{id:"id",kind:"paragraph",attrs:{},runs:[{text:"legacy",marks:[]}]}]}));',
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.stdout, "legacy\n");
});
test("named HTTP/desktop transfer capabilities preserve original DTOs", async () => {
  const calls = [],
    oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.body && JSON.parse(init.body)]);
    return Response.json({ safe: true });
  };
  try {
    const c = createHttpClient("/api");
    await c.inspectLegacyMigration();
    await c.issueMigrationTarget({
      requestId: request.requestId,
      projectId: request.projectId,
      destination: "managed",
    });
    await c.startLegacyMigration(request);
    await c.readMigrationOperation(request.requestId);
    await c.controlMigration(control);
    assert.deepEqual(
      calls.map((c) => c[0]),
      [
        "/api/v1/project/migration",
        "/api/v1/project/migration-targets",
        "/api/v1/project/migrations",
        `/api/v1/project/migrations/${request.requestId}`,
        `/api/v1/project/migrations/${request.requestId}/control`,
      ],
    );
    assert.deepEqual(calls[2][1], request);
    assert.deepEqual(calls[4][1], control);
  } finally {
    globalThis.fetch = oldFetch;
  }
  const bridgeCalls = [];
  const bridge = Object.fromEntries(
    methods.map((m) => [
      m,
      async (...args) => {
        bridgeCalls.push([m, args]);
        return { ok: true, data: { safe: true } };
      },
    ]),
  );
  const c = createDesktopClient(bridge);
  await c.startLegacyMigration(request);
  await c.controlMigration(control);
  assert.equal(bridgeCalls[0][1][0], request);
  assert.equal(bridgeCalls[1][1][0], control);
  assert.equal(createDesktopClient({}).startLegacyMigration, undefined);
});
test("preload exposes only named transfers and IPC rejects foreign sender/arbitrary locator", async () => {
  const handlers = new Map(),
    calls = [];
  let denied = false;
  registerProjectTransferIpc(
    { handle: (name, fn) => handlers.set(name, fn) },
    {
      checkSender() {
        if (denied) throw Error("ORIGIN_DENIED");
      },
      request: async (path, body) => {
        calls.push([path, body]);
        return { ok: true, data: {} };
      },
    },
  );
  assert.equal(handlers.size, 5);
  await handlers.get("project-transfer:startLegacyMigration")({}, request);
  assert.deepEqual(calls[0], ["/project/migrations", request]);
  assert.deepEqual(
    await handlers.get("project-transfer:readMigrationOperation")(
      {},
      "/tmp/project",
    ),
    { ok: false, code: "INVALID_REQUEST" },
  );
  denied = true;
  assert.deepEqual(
    await handlers.get("project-transfer:startLegacyMigration")({}, request),
    { ok: false, code: "ORIGIN_DENIED" },
  );
  const preload = await readFile("apps/desktop/src/preload.cts", "utf8");
  for (const m of methods) assert.ok(preload.includes(`project-transfer:${m}`));
});
