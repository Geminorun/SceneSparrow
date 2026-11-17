import test from "node:test";
import assert from "node:assert/strict";
import {
  NotificationStore,
  safeErrorCode,
  savedDiscoveryTarget,
} from "../../packages/editor-ui/src/notifications.ts";

test("notifications sanitize unknown/inherited codes and retain only bounded safe details", () => {
  const store = new NotificationStore(() => 1000);
  for (const value of [
    "SECRET_CANARY private vendor body",
    "__proto__",
    "constructor",
    "toString",
    { message: "AUTH_REJECTED" },
  ]) {
    assert.equal(safeErrorCode(value), "error");
  }
  const failure = Object.assign(new Error("PRIVATE_VENDOR_SECRET"), {
    status: 422,
    traceId: "a".repeat(32),
    body: "SECRET_CANARY",
  });
  store.push(failure, { target: "GET https://saved.example/custom/models" });
  assert.equal(store.getSnapshot()[0].key, "error");
  assert.equal(store.getSnapshot()[0].status, 422);
  assert.equal(store.getSnapshot()[0].traceId, "a".repeat(32));
  assert.equal(
    store.getSnapshot()[0].target,
    "GET https://saved.example/custom/models",
  );
  assert.doesNotMatch(
    JSON.stringify(store.getSnapshot()),
    /PRIVATE_VENDOR_SECRET|SECRET_CANARY/,
  );
  store.push(
    Object.assign(new Error("AUTH_REJECTED"), {
      status: 900,
      traceId: "unsafe trace SECRET",
    }),
  );
  assert.equal(store.getSnapshot()[0].status, undefined);
  assert.equal(store.getSnapshot()[0].traceId, undefined);
  assert.equal(
    savedDiscoveryTarget("https://user:key@example.test/v1"),
    undefined,
  );
  assert.equal(
    savedDiscoveryTarget("https://example.test/v1?key=secret"),
    undefined,
  );
  assert.equal(
    savedDiscoveryTarget("https://example.test/custom/"),
    "GET https://example.test/custom/models",
  );
});

test("queue/dedup are bounded, cancellation is silent and later actions can report again", () => {
  let now = 0;
  const store = new NotificationStore(() => now);
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  store.push("CANCELLED");
  store.push("NO_CHANGE");
  assert.equal(updates, 0);
  store.push("AUTH_REJECTED");
  store.push(new Error("AUTH_REJECTED"));
  assert.equal(store.getSnapshot().length, 1);
  const id = store.getSnapshot()[0].id;
  store.dismiss(id);
  store.push("AUTH_REJECTED", { passive: true });
  assert.equal(store.getSnapshot().length, 0);
  now = 8000;
  store.push("AUTH_REJECTED");
  assert.equal(store.getSnapshot().length, 1);
  store.dismiss(store.getSnapshot()[0].id);
  now = 16000;
  store.push("AUTH_REJECTED");
  store.push("ACCESS_REJECTED");
  store.push("MODEL_LIST_NOT_FOUND");
  store.push("MODEL_LIST_UNSUPPORTED");
  assert.equal(store.getSnapshot().length, 3);
  assert.deepEqual(
    store.getSnapshot().map((n) => n.key),
    ["MODEL_LIST_UNSUPPORTED", "MODEL_LIST_NOT_FOUND", "ACCESS_REJECTED"],
  );
  stop();
});

test("new failures retain a notice being read while the queue remains bounded", () => {
  const store = new NotificationStore(() => 1000);
  store.push("AUTH_REJECTED");
  const reading = store.getSnapshot()[0].id;
  store.hold(reading, true);
  for (const code of [
    "ACCESS_REJECTED",
    "MODEL_LIST_NOT_FOUND",
    "MODEL_LIST_UNSUPPORTED",
    "RATE_LIMITED",
  ])
    store.push(code);
  assert.equal(store.getSnapshot().length, 3);
  assert.ok(store.getSnapshot().some((notice) => notice.id === reading));
  assert.equal(store.getSnapshot()[0].key, "RATE_LIMITED");
});

test("same-code foreground errors refresh safe request context without replacing the focused identity", () => {
  let now = 0;
  const store = new NotificationStore(() => now);
  store.push(
    Object.assign(new Error("AUTH_REJECTED"), {
      status: 422,
      traceId: "a".repeat(32),
    }),
    { target: "GET https://first.example/custom/models" },
  );
  const id = store.getSnapshot()[0].id;
  store.hold(id, true);
  now = 4000;
  store.push(
    Object.assign(new Error("AUTH_REJECTED"), {
      status: 409,
      traceId: "b".repeat(32),
    }),
    { target: "GET https://second.example/root/models" },
  );
  assert.equal(store.getSnapshot().length, 1);
  assert.deepEqual(store.getSnapshot()[0], {
    id,
    key: "AUTH_REJECTED",
    tone: "error",
    expiresAt: 10000,
    status: 409,
    traceId: "b".repeat(32),
    target: "GET https://second.example/root/models",
  });
  store.push("AUTH_REJECTED");
  assert.equal(
    store.getSnapshot()[0].target,
    "GET https://second.example/root/models",
  );
});
