import test from "node:test";
import assert from "node:assert/strict";
import {
  NativeDelivery,
  deliveryError,
} from "../../apps/desktop/src/export-delivery.ts";
const action = { deliveryId: "delivery", jobId: "job", artifactHash: "hash" };
function fixture(options = {}) {
  let dialogs = 0,
    writes = 0,
    reads = 0;
  const persisted = new Map();
  const manager = new NativeDelivery({
    intent: async (a) => {
      if (!persisted.has(a.deliveryId))
        persisted.set(a.deliveryId, { ...a, status: "intent", error: null });
      return persisted.get(a.deliveryId);
    },
    artifact: async () => {
      reads++;
      return { job: { format: "txt" }, bytes: new Uint8Array([1]) };
    },
    choose: async () => {
      dialogs++;
      return options.cancel ? null : { capability: "opaque" };
    },
    commit: async () => {
      writes++;
      if (options.commitError) throw Error(options.commitError);
    },
    finish: async (a, status) => {
      if (options.loseAck && status === "saved") throw Error("network lost");
      const r = { ...a, status, error: null };
      persisted.set(a.deliveryId, r);
      return r;
    },
  });
  return { manager, persisted, counts: () => ({ dialogs, writes, reads }) };
}
test("native delivery replay validates full identity before dialog/fetch/write, cancellation allows explicit new delivery", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.manager.save(action, () => {}),
    f.manager.save(action, () => {}),
  ]);
  assert.equal(a.status, "saved");
  assert.deepEqual(a, b);
  assert.deepEqual(f.counts(), { dialogs: 1, writes: 1, reads: 1 });
  await assert.rejects(
    f.manager.save({ ...action, jobId: "other" }, () => {}),
    /INVALID_REQUEST/,
  );
  assert.deepEqual(f.counts(), { dialogs: 1, writes: 1, reads: 1 });
  const c = fixture({ cancel: true });
  assert.equal(await c.manager.save(action, () => {}), null);
  assert.equal(await c.manager.save(action, () => {}), null);
  await c.manager.save({ ...action, deliveryId: "explicit-new" }, () => {});
  assert.deepEqual(c.counts(), { dialogs: 2, writes: 0, reads: 2 });
});
test("post-finalization acknowledgment loss is unknown and replay never writes again", async () => {
  for (const options of [
    { loseAck: true },
    { commitError: "DELIVERY_STATUS_UNKNOWN" },
  ]) {
    const f = fixture(options);
    assert.equal((await f.manager.save(action, () => {})).status, "unknown");
    assert.equal((await f.manager.save(action, () => {})).status, "unknown");
    assert.equal(f.counts().writes, 1);
    assert.equal(f.persisted.get(action.deliveryId).status, "unknown");
  }
  const f = fixture();
  f.persisted.set(action.deliveryId, { ...action, status: "unknown" });
  assert.equal((await f.manager.save(action, () => {})).status, "unknown");
  assert.deepEqual(f.counts(), { dialogs: 0, writes: 0, reads: 0 });
});
test("owner change after awaited dialog fences external write and filesystem diagnostics are stable codes", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    f.manager.save(action, () => {
      if (++checks === 4) throw Error("CAPABILITY_EXPIRED");
    }),
    /CAPABILITY_EXPIRED/,
  );
  assert.equal(f.counts().writes, 0);
  for (const code of ["ENOENT", "EACCES"]) {
    assert.equal(
      deliveryError(
        Object.assign(Error(`${code}: /private/account/target.txt`), { code }),
      ),
      "DESTINATION_UNAVAILABLE",
    );
  }
});
test("native clipboard consumes a scoped preparation identity once and fences changed action/owner", async () => {
  const { NativeClipboard } =
    await import("../../apps/desktop/src/export-delivery.ts");
  let writes = 0,
    reads = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const manager = new NativeClipboard(
    async (id) => {
      reads++;
      await gate;
      return { id, text: "body", bodyHash: "hash" };
    },
    () => writes++,
  );
  const action = {
    deliveryId: "copy",
    preparationId: "prepared",
    bodyHash: "hash",
  };
  const first = manager.copy(action, () => {}),
    second = manager.copy(action, () => {});
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  await assert.rejects(
    manager.copy({ ...action, preparationId: "other" }, () => {}),
    /INVALID_REQUEST/,
  );
  assert.equal(writes, 1);
  const changed = new NativeClipboard(
    async () => ({ text: "body", bodyHash: "hash" }),
    () => writes++,
  );
  let checks = 0;
  await assert.rejects(
    changed.copy({ ...action, deliveryId: "new" }, () => {
      if (++checks > 1) throw Error("CAPABILITY_EXPIRED");
    }),
    /CAPABILITY_EXPIRED/,
  );
  assert.equal(writes, 1);
});
