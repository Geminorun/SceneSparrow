import test from "node:test";
import assert from "node:assert/strict";
import {
  createHttpClient,
  ApiError,
} from "../../packages/platform-client/src/index.ts";

const scope = { projectId: "project", sessionId: "session", turnId: "turn" };
const event = (sequence, type, extra = {}) => ({
  sequence,
  ...scope,
  type,
  ...extra,
});
const frame = (events) => `event: agent\ndata: ${JSON.stringify(events)}\n\n`;
function response(text, cancelled) {
  return new Response(
    new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        c.enqueue(bytes.slice(0, 29));
        c.enqueue(bytes.slice(29));
      },
      cancel: cancelled,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
test("EWA-AC03 HTTP client scopes requests, preserves unavailable errors and never resends", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ code: "AGENT_UNAVAILABLE" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = createHttpClient("http://local").agent;
    await assert.rejects(
      client.create("project", {
        requestId: "request",
        engineId: "codex",
        modelId: "gpt-5.4",
      }),
      (error) =>
        error instanceof ApiError && error.code === "AGENT_UNAVAILABLE",
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "http://local/v1/markdown-projects/project/agent/sessions",
    );
    assert.equal(JSON.parse(calls[0].options.body).requestId, "request");
  } finally {
    globalThis.fetch = original;
  }
});
test("EWA-AC03 stream replay deduplicates, preserves UTF-8 and abort fences a queued proposal", async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  const abort = new AbortController(),
    seen = [];
  globalThis.fetch = async () =>
    response(
      frame([
        event(1, "text", { text: "中文" }),
        event(1, "text", { text: "duplicate" }),
        event(2, "proposal", { proposal: {} }),
        event(3, "final", {
          status: "completed",
          reply: "Done",
          errorCode: null,
        }),
      ]),
      () => {
        cancelled++;
      },
    );
  try {
    await createHttpClient("http://local").agent.stream(
      "project",
      "session",
      "turn",
      0,
      (event) => {
        seen.push(event);
        abort.abort();
      },
      abort.signal,
    );
    assert.deepEqual(
      seen.map((e) => e.text),
      ["中文"],
    );
    assert.equal(cancelled, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("EWA streams reject wrong scopes and terminal failures without accepting late proposals", async () => {
  const original = globalThis.fetch;
  try {
    for (const events of [
      [event(1, "text", { projectId: "other", text: "Cross-project" })],
      [
        event(1, "final", {
          status: "failed",
          reply: "",
          errorCode: "AGENT_OUTPUT_INVALID",
        }),
        event(2, "proposal", { proposal: {} }),
      ],
      [event(2, "text", { text: "Missing sequence" })],
    ]) {
      globalThis.fetch = async () => response(frame(events), () => {});
      const seen = [];
      await assert.rejects(
        createHttpClient("http://local").agent.stream(
          "project",
          "session",
          "turn",
          0,
          (e) => seen.push(e),
          new AbortController().signal,
        ),
        (error) => error.code === "AGENT_STREAM_INVALID",
      );
      assert.ok(seen.every((e) => e.type !== "proposal"));
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("EWA complete stream delivers one final and a bounded partial frame fails", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      response(
        frame([
          event(1, "text", { text: "Reply" }),
          event(1, "text", { text: "duplicate" }),
          event(2, "final", {
            status: "completed",
            reply: "Reply",
            errorCode: null,
          }),
        ]),
        () => {},
      );
    const seen = [];
    await createHttpClient("http://local").agent.stream(
      "project",
      "session",
      "turn",
      0,
      (e) => seen.push(e),
      new AbortController().signal,
    );
    assert.deepEqual(
      seen.map((e) => e.type),
      ["text", "final"],
    );
    globalThis.fetch = async () =>
      response("x".repeat(8 * 1024 * 1024 + 1), () => {});
    await assert.rejects(
      createHttpClient("http://local").agent.stream(
        "project",
        "session",
        "turn",
        0,
        () => {},
        new AbortController().signal,
      ),
      (error) => error.code === "AGENT_OUTPUT_LIMIT",
    );
  } finally {
    globalThis.fetch = original;
  }
});
