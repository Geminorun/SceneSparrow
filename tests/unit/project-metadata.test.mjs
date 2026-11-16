import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  TransportError,
  createHttpClient,
  createDesktopClient,
} from "../../packages/platform-client/src/index.ts";

test("HTTP project bootstrap and rename use named POST operations and preserve conflict errors", async () => {
  const original = globalThis.fetch;
  const calls = [];
  const project = {
    id: "stable-id",
    title: "Untitled project",
    workingRevision: 7,
    approvedBaseline: 4,
  };
  const ensure = { requestId: "first-open", title: "Untitled project" };
  const rename = {
    requestId: "rename",
    projectId: project.id,
    previousTitle: project.title,
    title: "Named project",
  };
  globalThis.fetch = async (url, options) => {
    calls.push([url, options.method, JSON.parse(options.body)]);
    return calls.length > 2
      ? Response.json({ code: "PROJECT_CONFLICT" }, { status: 409 })
      : Response.json({ project });
  };
  try {
    const client = createHttpClient("https://scene.example/api");
    assert.deepEqual(await client.ensureProject(ensure), { project });
    assert.deepEqual(await client.renameProject(rename), { project });
    await assert.rejects(
      client.renameProject(rename),
      (e) => e instanceof ApiError && e.code === "PROJECT_CONFLICT",
    );
    assert.deepEqual(calls, [
      ["https://scene.example/api/v1/project/ensure", "POST", ensure],
      ["https://scene.example/api/v1/project/rename", "POST", rename],
      ["https://scene.example/api/v1/project/rename", "POST", rename],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("desktop project bootstrap and rename unwrap scoped bridge results and surface stale conflicts", async () => {
  const calls = [];
  const project = {
    id: "stable-id",
    title: "Untitled project",
    workingRevision: 7,
    approvedBaseline: 4,
  };
  const ensure = { requestId: "first-open", title: project.title };
  const rename = {
    requestId: "rename",
    projectId: project.id,
    previousTitle: project.title,
    title: "Named project",
  };
  const client = createDesktopClient({
    ensureProject: async (command) => {
      calls.push(["ensure", command]);
      return { ok: true, data: { project } };
    },
    renameProject: async (command) => {
      calls.push(["rename", command]);
      return { ok: false, code: "PROJECT_CONFLICT" };
    },
  });
  assert.deepEqual(await client.ensureProject(ensure), { project });
  await assert.rejects(
    client.renameProject(rename),
    (e) => e instanceof ApiError && e.code === "PROJECT_CONFLICT",
  );
  assert.deepEqual(calls, [
    ["ensure", ensure],
    ["rename", rename],
  ]);
});

// An uncertain metadata response cannot be treated as a definitive rejection or
// silently retried with a replacement command identity.
test("metadata writes classify malformed responses and retain original commands for explicit retry", async (t) => {
  const trace = "a".repeat(32);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options.method, JSON.parse(options.body)]);
    return new Response('{"project":', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "X-SceneSparrow-Trace-Id": trace,
      },
    });
  });
  const client = createHttpClient();
  for (const [method, path, command] of [
    [
      "ensureProject",
      "ensure",
      { requestId: "first-open", title: "Untitled project" },
    ],
    [
      "renameProject",
      "rename",
      {
        requestId: "rename-original",
        projectId: "stable-id",
        previousTitle: "Untitled project",
        title: "Named project",
      },
    ],
  ]) {
    const before = calls.length;
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(client[method](command), (error) => {
        assert.ok(error instanceof TransportError);
        assert.ok(!(error instanceof ApiError));
        assert.equal(error.code, "RESPONSE_INVALID_JSON");
        assert.equal(error.status, 200);
        assert.equal(error.traceId, trace);
        return true;
      });
    assert.deepEqual(calls.slice(before), [
      [`/api/v1/project/${path}`, "POST", command],
      [`/api/v1/project/${path}`, "POST", command],
    ]);
  }
});
