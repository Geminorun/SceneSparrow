import test from "node:test";
import assert from "node:assert/strict";
import { createHttpClient } from "../../packages/platform-client/src/http.ts";
import { createDesktopClient } from "../../packages/platform-client/src/desktop.ts";

test("named source adapters keep raw request/hash/generation and late snapshots intact", async () => {
  const calls = [];
  const old = globalThis.fetch;
  const snapshot = {
    projectId: "project",
    workingRevision: 8,
    generation: 2,
    acceptedHash: "old",
    source: "accepted old buffer\r\n",
    bindings: [],
    semanticBlockIds: [],
    externalStatus: "changed",
    externalHash: "outside",
  };
  const request = {
    requestId: "original",
    projectId: "project",
    expectedWorkingRevision: 8,
    expectedGeneration: 2,
    expectedHash: "old",
    source: "author input\r\n",
    group: {
      groupId: "group",
      clientSessionId: "session",
      groupSequence: 1,
      kind: "typing",
    },
  };
  const receipt = { requestId: "original" };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("/format")
        ? { status: "managed", formatVersion: 1, projectId: "project" }
        : init.body
          ? { receipt, snapshot }
          : snapshot,
    );
  };
  try {
    const client = createHttpClient("/api");
    assert.equal((await client.inspectProjectFormat()).status, "managed");
    assert.deepEqual(await client.readAuthoredSource(), snapshot);
    const saved = await client.saveAuthoredSource(request);
    assert.deepEqual(saved.snapshot, snapshot);
    assert.deepEqual(JSON.parse(calls[2].init.body), request);
    assert.equal(calls[2].url, "/api/v1/manuscript/source");
  } finally {
    globalThis.fetch = old;
  }
  const bridgeCalls = [];
  const client = createDesktopClient({
    inspectProjectFormat: async () => ({
      ok: true,
      data: { status: "managed" },
    }),
    readAuthoredSource: async () => ({ ok: true, data: snapshot }),
    saveAuthoredSource: async (body) => {
      bridgeCalls.push(body);
      return { ok: true, data: { receipt, snapshot } };
    },
  });
  assert.equal((await client.inspectProjectFormat()).status, "managed");
  assert.deepEqual(await client.readAuthoredSource(), snapshot);
  assert.deepEqual(await client.saveAuthoredSource(request), {
    receipt,
    snapshot,
  });
  assert.equal(bridgeCalls[0], request);
});
