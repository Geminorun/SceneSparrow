import test from "node:test";
import assert from "node:assert/strict";
import {
  subscribeProjectEvents,
  createDesktopClient,
  validateExternalLink,
} from "../../packages/platform-client/src/index.ts";
test("authenticated fetch SSE reconnects at last delivered cursor, deduplicates and requests snapshot resync", async () => {
  const original = globalThis.fetch;
  const calls = [],
    received = [];
  let resync = 0,
    stop;
  const event = (n) =>
    `event: project\ndata: ${JSON.stringify({ sequence: n, projectId: "p", type: "sources.changed", workingRevision: 1, affectedIds: [] })}\n\n`;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const text =
      calls.length === 1
        ? event(1) + event(1) + event(2)
        : event(2) + event(3) + "event: resync_required\ndata: 1001\n\n";
    return new Response(
      new ReadableStream({
        start(controller) {
          const bytes = new TextEncoder().encode(text);
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    stop = subscribeProjectEvents(
      "http://local/v1/project/events",
      { Authorization: "Bearer ephemeral" },
      (e) => received.push(e.sequence),
      () => {
        resync++;
        stop();
      },
    );
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () =>
        resync
          ? resolve()
          : Date.now() - start > 3000
            ? reject(Error("SSE timeout"))
            : setTimeout(check, 10);
      check();
    });
    assert.deepEqual(received, [1, 2, 3]);
    assert.equal(resync, 1);
    assert.ok(calls[1].url.endsWith("after=2"));
    assert.equal(calls[0].options.headers.Authorization, "Bearer ephemeral");
    assert.ok(calls.every((c) => !c.url.includes("token")));
  } finally {
    stop?.();
    globalThis.fetch = original;
  }
});
test("desktop file intake cancellation and progress remain scoped to the selection identity", async () => {
  let selected,
    handler,
    removed = false,
    cancelled;
  let release;
  const bridge = {
    onFileIntakeProgress: (id, cb) => {
      selected = id;
      handler = cb;
      return () => {
        removed = true;
      };
    },
    pickFileIntake: (id) => {
      assert.equal(id, selected);
      return new Promise((r) => {
        release = r;
      });
    },
    cancelFileSelection: async (id) => {
      cancelled = id;
      return { ok: true, data: null };
    },
  };
  const client = createDesktopClient(bridge),
    abort = new AbortController(),
    progress = [];
  const pending = client.pickFileIntake(abort.signal, (loaded, total) =>
    progress.push([loaded, total]),
  );
  handler(20, 100);
  abort.abort();
  await Promise.resolve();
  assert.equal(cancelled, selected);
  release({ ok: true, data: null });
  assert.equal(await pending, null);
  assert.deepEqual(progress, [[20, 100]]);
  assert.ok(removed);
  for (const url of [
    "file:///etc/passwd",
    "https://u:p@example.com",
    "javascript:alert(1)",
  ])
    assert.throws(() => validateExternalLink(url));
  validateExternalLink("https://example.com/path");
});
