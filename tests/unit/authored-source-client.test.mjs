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

test("named source reconciliation adapters preserve candidates and original action DTO", async () => {
  const calls = [];
  const previous = globalThis.fetch;
  const status = {
    generation: 3,
    acceptedHash: "accepted",
    candidateId: "candidate",
    pendingIntent: { requestId: "pending", intentHash: "hash", version: 2 },
    watchMode: "native",
  };
  const action = {
    requestId: "original",
    projectId: "project",
    candidateId: "candidate",
    candidateHash: "external",
    expectedHash: "accepted",
    expectedGeneration: 3,
    expectedWorkingRevision: 5,
    disposition: "proposal",
    source: "raw\r\n",
    group: {
      groupId: "group",
      clientSessionId: "session",
      groupSequence: 1,
      kind: "discrete",
    },
  };
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return Response.json(status);
  };
  try {
    const client = createHttpClient("/api");
    assert.deepEqual(await client.readAuthoredSourceStatus(), status);
    await client.rescanAuthoredSource();
    await client.readAuthoredSourceCandidate("candidate/id");
    await client.resolveAuthoredSource(action);
    await client.recoverAuthoredSource({
      projectId: "project",
      intentHash: "hash",
      requestId: "pending",
    });
    assert.equal(calls[0][0], "/api/v1/manuscript/source/status");
    assert.equal(calls[1][1].method, "POST");
    assert.equal(
      calls[2][0],
      "/api/v1/manuscript/source/candidates/candidate%2Fid",
    );
    assert.deepEqual(JSON.parse(calls[3][1].body), action);
    assert.equal(calls[4][0], "/api/v1/manuscript/source/recover");
  } finally {
    globalThis.fetch = previous;
  }
  const invoked = [];
  const bridge = Object.fromEntries(
    [
      "readAuthoredSourceStatus",
      "rescanAuthoredSource",
      "readAuthoredSourceCandidate",
      "resolveAuthoredSource",
      "recoverAuthoredSource",
    ].map((name) => [
      name,
      async (...args) => {
        invoked.push([name, ...args]);
        return { ok: true, data: status };
      },
    ]),
  );
  const desktop = createDesktopClient(bridge);
  assert.deepEqual(await desktop.readAuthoredSourceStatus(), status);
  await desktop.rescanAuthoredSource();
  await desktop.readAuthoredSourceCandidate("candidate");
  await desktop.resolveAuthoredSource(action);
  await desktop.recoverAuthoredSource({
    projectId: "project",
    intentHash: "hash",
    requestId: "pending",
  });
  assert.equal(invoked[3][1], action);
});

test("recovery evidence uses named project/intent-scoped read capabilities", async () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return Response.json({ intentHash: "intent", versions: [] });
  };
  try {
    const client = createHttpClient("/api");
    await client.readAuthoredSourceRecoveryEvidence("intent/hash");
    await client.readAuthoredSourceRecoveryVersion(
      "intent/hash",
      "source/hash",
    );
    assert.equal(
      calls[0][0],
      "/api/v1/manuscript/source/recoveries/intent%2Fhash/evidence",
    );
    assert.equal(
      calls[1][0],
      "/api/v1/manuscript/source/recoveries/intent%2Fhash/evidence/source%2Fhash",
    );
    assert.equal(calls[0][1].method, "GET");
    assert.equal(calls[1][1].body, undefined);
  } finally {
    globalThis.fetch = previous;
  }
  const invoked = [];
  const desktop = createDesktopClient({
    readAuthoredSourceRecoveryEvidence: async (...args) => {
      invoked.push(args);
      return { ok: true, data: { versions: [] } };
    },
    readAuthoredSourceRecoveryVersion: async (...args) => {
      invoked.push(args);
      return { ok: true, data: { source: null, bytesBase64: "/w==" } };
    },
  });
  await desktop.readAuthoredSourceRecoveryEvidence("intent");
  assert.equal(
    (await desktop.readAuthoredSourceRecoveryVersion("intent", "source"))
      .source,
    null,
  );
  assert.deepEqual(invoked, [["intent"], ["intent", "source"]]);
});
