import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  createHttpClient,
  ApiError,
  TransportError,
  onTransportFailure,
} from "../../packages/platform-client/src/index.ts";
import {
  decodeJson,
  decodeJsonText,
} from "../../packages/platform-client/src/transport.ts";
const trace = "a".repeat(32);
const response = (
  body,
  status = 200,
  mime = "application/json",
  traceId = trace,
) =>
  new Response(body, {
    status,
    headers: { "content-type": mime, "X-SceneSparrow-Trace-Id": traceId },
  });
const fails = (code, status, traceId) => (error) => {
  assert.ok(error instanceof TransportError);
  assert.ok(!(error instanceof ApiError));
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(error.traceId, traceId);
  assert.equal(error.message, `TRANSPORT_${code}`);
  return true;
};
for (const [body, status, mime, code] of [
  ["<secret html>", 200, "text/html", "RESPONSE_NOT_JSON"],
  ["", 200, "application/json", "RESPONSE_EMPTY"],
  ["   ", 200, "application/json", "RESPONSE_EMPTY"],
  ['{"project":', 200, "application/json", "RESPONSE_INVALID_JSON"],
  ["<secret html>", 401, "text/html", "AUTH_REQUIRED"],
  ["", 403, "text/html", "AUTH_REQUIRED"],
  ["<secret html>", 502, "text/html", "HTTP_ERROR"],
  ['{"code":"SERVICE_UNAVAILABLE"}', 503, "application/json", "HTTP_ERROR"],
  ['{"code":"RATE_LIMITED"}', 429, "application/json", "HTTP_ERROR"],
]) {
  test(`safe classification ${status} ${code}`, async () => {
    await assert.rejects(
      decodeJson(response(body, status, mime)),
      fails(code, status, trace),
    );
    assert.throws(
      () => decodeJsonText(status, mime, body, trace),
      fails(code, status, trace),
    );
  });
}
test("contractual rejections remain ApiError, with safe HTTP metadata", async () => {
  await assert.rejects(
    decodeJson(
      response(
        '{"code":"REVISION_CONFLICT","details":{"historyRevision":1}}',
        409,
      ),
    ),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, "REVISION_CONFLICT");
      assert.equal(e.status, 409);
      assert.equal(e.traceId, trace);
      return true;
    },
  );
});
test("JSON MIME parameters/suffix succeed and only an explicit empty contract accepts 204/HEAD", async () => {
  assert.deepEqual(
    await decodeJson(
      response('{"ok":true}', 200, "application/problem+json; charset=utf-8"),
    ),
    { ok: true },
  );
  await assert.rejects(
    decodeJson(new Response(null, { status: 204 })),
    fails("RESPONSE_NOT_JSON", 204, undefined),
  );
  assert.equal(
    await decodeJson(new Response(null, { status: 204 }), "GET", true),
    undefined,
  );
  assert.equal(await decodeJson(new Response(null), "HEAD", true), undefined);
  await assert.rejects(
    decodeJson(response(""), "GET", true),
    fails("RESPONSE_EMPTY", 200, trace),
  );
});
test("invalid trace and untrusted status never become presentation metadata", async () => {
  await assert.rejects(
    decodeJson(response("oops", 200, "application/json", "secret-canary")),
    fails("RESPONSE_INVALID_JSON", 200, undefined),
  );
  assert.equal(
    new TransportError("HTTP_ERROR", 999, "A".repeat(32)).status,
    undefined,
  );
  assert.equal(
    new TransportError("HTTP_ERROR", 500, "A".repeat(32)).traceId,
    undefined,
  );
});
test("body timeout differs from truncated stream and preserves safe trace", async () => {
  const abort = new AbortController();
  const timeout = new DOMException("sensitive internal detail", "TimeoutError");
  abort.abort(timeout);
  const failedBody = (error) => ({
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
      "X-SceneSparrow-Trace-Id": trace,
    }),
    text: async () => {
      throw error;
    },
  });
  await assert.rejects(
    decodeJson(failedBody(timeout), "GET", false, abort.signal),
    fails("NETWORK_TIMEOUT", 200, trace),
  );
  await assert.rejects(
    decodeJson(failedBody(new TypeError("secret truncated content"))),
    fails("RESPONSE_INVALID_JSON", 200, trace),
  );
});
test("fetch failures classify without retrying a write or exposing thrown text", async (t) => {
  for (const [thrown, code] of [
    [new DOMException("secret timeout", "TimeoutError"), "NETWORK_TIMEOUT"],
    [new TypeError("secret network"), "NETWORK_FAILED"],
  ]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      throw thrown;
    });
    const errors = [];
    const off = onTransportFailure((e) => errors.push(e));
    await assert.rejects(
      createHttpClient().createProject({
        title: "private",
        requestId: "original",
      }),
      fails(code, undefined, undefined),
    );
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    off();
    t.mock.restoreAll();
  }
});
test("binary body timeouts retain their signal, HTTP status and safe trace", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const abort = new AbortController();
  abort.abort(new DOMException("private timeout detail", "TimeoutError"));
  t.mock.method(AbortSignal, "timeout", () => abort.signal);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "X-SceneSparrow-Trace-Id": trace }),
    arrayBuffer: async () => {
      throw new DOMException("private body detail", "AbortError");
    },
  });
  for (const operation of ["exportBytes", "readAiResult"])
    await assert.rejects(
      createHttpClient()[operation]("private-id"),
      fails("NETWORK_TIMEOUT", 200, trace),
    );
});
test("binary success parsers preserve bytes and byte caps", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    response(new Uint8Array([0, 255, 10]), 200, "application/octet-stream"),
  );
  assert.deepEqual(
    await createHttpClient().exportBytes("private-id"),
    new Uint8Array([0, 255, 10]),
  );
  assert.deepEqual(
    await createHttpClient().readAiResult("private-id"),
    new Uint8Array([0, 255, 10]),
  );
  t.mock.method(globalThis, "fetch", async () =>
    response(new Uint8Array(8388609), 200, "application/octet-stream"),
  );
  await assert.rejects(createHttpClient().readAiResult("private-id"), {
    code: "OUTPUT_TRUNCATED",
  });
});
const source = await readFile(
  new URL("../../apps/web/public/bootstrap-diagnostics.js", import.meta.url),
  "utf8",
);
function bootstrap(protocol = "https:", desktop = false, fetcher) {
  const listeners = new Map();
  const sent = [];
  const window = {
    ...(desktop ? { sceneSparrow: {} } : {}),
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const context = {
    window,
    location: { protocol },
    document: { querySelector: () => ({ content: "b".repeat(40) }) },
    fetch:
      fetcher ??
      (async (url, init) => {
        sent.push({ url, init });
      }),
    AbortSignal,
    Date,
    Promise,
    Set,
    Map,
  };
  vm.runInNewContext(source, context);
  return { window, listeners, sent };
}
const event = {
  code: "RESPONSE_INVALID_JSON",
  stage: "decode",
  routeId: "project",
  status: 200,
  traceId: trace,
  stack: "secret-canary",
  url: "private-url",
  message: "private-content",
};
test("independent bootstrap catches bundle failure before mounting with no error properties", async () => {
  const { listeners, sent, window } = bootstrap();
  listeners.get("error")({
    target: window,
    error: { stack: "secret-canary" },
    message: "private-content",
  });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.code, "BOOTSTRAP_FAILED");
  assert.equal(body.stage, "bootstrap");
  assert.equal(body.appBuild, "b".repeat(40));
  assert.ok(!JSON.stringify(sent).includes("secret-canary"));
  window.sceneSparrowDiagnostics.mounted();
  listeners.get("unhandledrejection")({ reason: "secret-canary" });
  assert.equal(sent.length, 1);
});
test("bootstrap reporter disables HTTP/file/desktop, drops unknown metadata and bounds reports", async () => {
  for (const protocol of ["http:", "file:"])
    assert.equal(bootstrap(protocol).window.sceneSparrowDiagnostics, undefined);
  assert.equal(
    bootstrap("https:", true).window.sceneSparrowDiagnostics,
    undefined,
  );
  const { window, sent } = bootstrap();
  const report = window.sceneSparrowDiagnostics.report;
  report(event);
  report(event);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(sent[0].init.body)).sort(),
    [
      "appBuild",
      "code",
      "component",
      "eventCode",
      "level",
      "routeId",
      "schemaVersion",
      "stage",
      "status",
      "traceId",
    ].sort(),
  );
  assert.equal(sent[0].url, "/diagnostics/v1/client-events");
  assert.ok(!JSON.stringify(sent).includes("secret-canary"));
  report({ ...event, routeId: "private-url" });
  assert.equal(sent.length, 1);
});
test("reporter failure cannot escape or recursively report", async () => {
  const { window } = bootstrap("https:", false, async () => {
    throw new Error("secret-canary");
  });
  assert.doesNotThrow(() => window.sceneSparrowDiagnostics.report(event));
  await new Promise((r) => setImmediate(r));
});
test("XHR retains upload progress and looks up malformed committed intake by its original identity", async (t) => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "XMLHttpRequest",
  );
  t.after(() =>
    original
      ? Object.defineProperty(globalThis, "XMLHttpRequest", original)
      : delete globalThis.XMLHttpRequest,
  );
  let xhr;
  globalThis.XMLHttpRequest = class {
    constructor() {
      xhr = this;
      this.upload = {};
      this.headers = {};
      this.status = 200;
      this.responseText = '{"intake":';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(key, value) {
      this.headers[key] = value;
    }
    getResponseHeader(key) {
      return key === "content-type" ? "application/json" : trace;
    }
    send(file) {
      this.upload.onprogress({ loaded: file.size });
      queueMicrotask(() => this.onload());
    }
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return response(
      JSON.stringify({ id: xhr.headers["x-intake-id"], status: "ready" }),
    );
  });
  const progress = [];
  const file = new File(["private-content"], "private-name.txt");
  const result = await createHttpClient().uploadFile(
    file,
    undefined,
    (...args) => progress.push(args),
  );
  assert.deepEqual(progress, [[file.size, file.size]]);
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.timeout, 120000);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `/api/v1/intakes/${xhr.headers["x-intake-id"]}`,
  );
  assert.equal(result.id, xhr.headers["x-intake-id"]);
  assert.equal(requests[0].init.method, "GET");
});
test("independent reporter lifetime cap remains bounded across distinct failures", async () => {
  const { window, sent } = bootstrap();
  const codes = [
    "AUTH_REQUIRED",
    "HTTP_ERROR",
    "NETWORK_TIMEOUT",
    "NETWORK_FAILED",
    "RESPONSE_NOT_JSON",
    "RESPONSE_EMPTY",
    "RESPONSE_INVALID_JSON",
    "BOOTSTRAP_FAILED",
  ];
  for (const code of codes) {
    for (const routeId of [
      "document",
      "asset",
      "project",
      "manuscript",
      "ai",
      "events",
      "diagnostics",
      "unknown",
    ]) {
      window.sceneSparrowDiagnostics.report({
        code,
        routeId,
        stage: "request",
        traceId: "secret-canary",
      });
      await new Promise((r) => setImmediate(r));
    }
  }
  assert.equal(sent.length, 30);
  assert.ok(!JSON.stringify(sent).includes("secret-canary"));
});
