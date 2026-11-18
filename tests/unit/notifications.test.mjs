import test from "node:test";
import assert from "node:assert/strict";
import {
  NotificationStore,
  safeErrorCode,
  savedDiscoveryTarget,
} from "../../packages/editor-ui/src/feedback/notifications.ts";

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
  assert.equal(safeErrorCode("DOCUMENT_INVALID"), "DOCUMENT_INVALID");
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
    expiresAt: null,
    fading: false,
    identity: "error:AUTH_REJECTED",
    owner: undefined,
    actions: [],
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

test("transient errors retain actions, passive duplicates preserve owner actions, explicit errors can return after dismissal", async () => {
  let now = 0,
    calls = 0;
  const store = new NotificationStore(() => now);
  const owner = store.createOwner();
  store.push("AUTH_REJECTED", { passive: true });
  store.push(new Error("AUTH_REJECTED"), {
    owner,
    identity: "discovery:one",
    actions: [{ kind: "retry", run: () => calls++ }],
    target: "GET https://saved.example/v1/models",
  });
  const notice = store.getSnapshot()[0];
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(notice.expiresAt, 3000);
  now = 60000;
  store.push("AUTH_REJECTED", { passive: true });
  assert.equal(store.getSnapshot()[0], notice);
  assert.deepEqual(notice.actions, ["retry"]);
  store.runAction(notice.id, "retry");
  store.runAction(notice.id, "retry");
  await Promise.resolve();
  assert.equal(calls, 1);
  store.push("AUTH_REJECTED", { passive: true });
  assert.equal(store.getSnapshot().length, 0);
  store.push("AUTH_REJECTED", {
    owner,
    identity: "discovery:one",
    actions: [{ kind: "retry", run: () => calls++ }],
  });
  assert.equal(store.getSnapshot().length, 1);
  assert.equal(store.getSnapshot()[0].target, undefined);
  store.releaseOwner(owner);
  assert.equal(store.getSnapshot().length, 0);
});

test("owners revoke callbacks and notices, including between a click and its microtask", async () => {
  const store = new NotificationStore();
  let calls = 0;
  const owner = store.createOwner();
  store.push("AI_ERROR", {
    owner,
    actions: [{ kind: "retry", run: () => calls++ }],
  });
  const id = store.getSnapshot()[0].id;
  store.runAction(id, "retry");
  store.releaseOwner(owner);
  await Promise.resolve();
  assert.equal(calls, 0);
  store.push("AI_ERROR", {
    owner,
    actions: [{ kind: "retry", run: () => calls++ }],
  });
  assert.equal(store.getSnapshot().length, 0);
  const other = store.createOwner();
  store.push("AI_ERROR", {
    owner: other,
    identity: "one",
    actions: [{ kind: "recovery", run: () => calls++ }],
  });
  store.push("AUTH_REJECTED", {
    owner: other,
    identity: "two",
    actions: [{ kind: "retry", run: () => calls++ }],
  });
  store.resolveOwner(other, "one");
  assert.deepEqual(
    store.getSnapshot().map((notice) => notice.identity),
    ["two"],
  );
  store.releaseOwner(other);
  assert.equal(store.getSnapshot().length, 0);
});

test("new owner request context clears stale diagnostics and failed actions are sanitized", async () => {
  const store = new NotificationStore(() => 1000),
    owner = store.createOwner();
  store.push(
    Object.assign(new Error("AI_ERROR"), {
      status: 422,
      traceId: "a".repeat(32),
    }),
    {
      owner,
      identity: "request",
      target: "GET https://first.example/v1/models",
    },
  );
  store.push("AI_ERROR", {
    owner,
    identity: "request",
    actions: [
      {
        kind: "retry",
        run: () => {
          throw new Error("SECRET_CALLBACK_BODY");
        },
      },
    ],
  });
  const notice = store.getSnapshot()[0];
  assert.equal(notice.status, undefined);
  assert.equal(notice.traceId, undefined);
  assert.equal(notice.target, undefined);
  assert.doesNotMatch(JSON.stringify(notice), /run|SECRET/);
  store.runAction(notice.id, "retry");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot()[0].key, "error");
  assert.doesNotMatch(
    JSON.stringify(store.getSnapshot()),
    /SECRET_CALLBACK_BODY/,
  );
  store.push("aiConfigurationSaved", { tone: "success" });
  assert.equal(store.getSnapshot()[0].expiresAt, 4000);
});

test("action descriptors are typed, unique, bounded and require a live owner", () => {
  const store = new NotificationStore(),
    owner = store.createOwner();
  const actions = Array.from({ length: 30 }, () => ({
    kind: "retry",
    run() {},
  }));
  actions.push({ kind: "SECRET_UNTRUSTED_LABEL", run() {} });
  store.push("AI_ERROR", { actions });
  assert.deepEqual(store.getSnapshot()[0].actions, []);
  store.push("AI_ERROR", { owner, actions });
  assert.deepEqual(store.getSnapshot()[0].actions, ["retry"]);
  assert.doesNotMatch(
    JSON.stringify(store.getSnapshot()),
    /SECRET_UNTRUSTED_LABEL/,
  );
});

test("opaque operation identifiers resolve consistently without exposing user model text", () => {
  const store = new NotificationStore(),
    owner = store.createOwner();
  const identity = 'model:["provider-id","PRIVATE_MODEL_LABEL / 中文"]';
  store.push("SETTINGS_CONFLICT", {
    owner,
    identity,
    actions: [{ kind: "retry", run() {} }],
  });
  assert.doesNotMatch(
    JSON.stringify(store.getSnapshot()),
    /PRIVATE_MODEL_LABEL|中文/,
  );
  store.resolveOwner(owner, identity);
  assert.equal(store.getSnapshot().length, 0);
});

test("all notices expire after three seconds and fade, holding preserves remaining lifetime and passive polling never replays expiry", () => {
  let now = 0;
  const store = new NotificationStore(() => now),
    owner = store.createOwner();
  store.push("AI_ERROR", {
    owner,
    identity: "original",
    actions: [{ kind: "retry", run() {} }],
  });
  const id = store.getSnapshot()[0].id;
  now = 1000;
  store.hold(id, true);
  assert.equal(store.getSnapshot()[0].expiresAt, null);
  now = 6000;
  store.tick(id);
  assert.equal(store.getSnapshot().length, 1);
  store.hold(id, false);
  assert.equal(store.getSnapshot()[0].expiresAt, 8000);
  now = 7999;
  store.tick(id);
  assert.equal(store.getSnapshot()[0].fading, undefined);
  now = 8000;
  store.tick(id);
  assert.equal(store.getSnapshot()[0].fading, true);
  now = 8189;
  store.tick(id);
  assert.equal(store.getSnapshot().length, 1);
  now = 8190;
  store.tick(id);
  assert.equal(store.getSnapshot().length, 0);
  now = 60000;
  store.push("AI_ERROR", { owner, identity: "original", passive: true });
  assert.equal(store.getSnapshot().length, 0);
  store.push("AI_ERROR", { owner, identity: "original" });
  assert.equal(store.getSnapshot()[0].expiresAt, 63000);
  store.push("aiConfigurationSaved", { tone: "success" });
  assert.equal(store.getSnapshot()[0].expiresAt, 63000);
});

test("a recovered owner or a fresh error episode can report the same code after an earlier toast expired", () => {
  let now = 0;
  const store = new NotificationStore(() => now),
    owner = store.createOwner();
  store.push("AI_ERROR", { owner, identity: "load", passive: true });
  const expire = () => {
    const id = store.getSnapshot()[0].id;
    now += 3000;
    store.tick(id);
    now += 190;
    store.tick(id);
    assert.equal(store.getSnapshot().length, 0);
  };
  expire();
  now = 60000;
  store.push("AI_ERROR", { owner, identity: "load", passive: true });
  assert.equal(store.getSnapshot().length, 0);
  store.resolveOwner(owner, "load");
  store.push("AI_ERROR", { owner, identity: "load", passive: true });
  assert.equal(store.getSnapshot()[0].expiresAt, 63000);
  expire();
  store.push("AI_ERROR", { identity: "hook:episode:2", passive: true });
  assert.equal(store.getSnapshot().length, 1);
});
