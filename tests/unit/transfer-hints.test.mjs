import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readTransferHints,
  writeTransferHint,
  discardTransferHint,
} from "../../packages/editor-ui/src/project-transfer/transfer-hints.ts";
function storage() {
  let value = null;
  return {
    getItem() {
      return value;
    },
    setItem(_key, data) {
      value = data;
    },
  };
}
test("transfer recovery hints are bounded, expiring safe DTOs and exclude foreign project/prose/private paths", () => {
  const s = storage(),
    projectId = randomUUID(),
    now = Date.now();
  for (let n = 0; n < 25; n++)
    writeTransferHint(
      {
        version: 1,
        id: randomUUID(),
        projectId,
        kind: "export",
        createdAt: now - n,
      },
      s,
      now,
    );
  assert.equal(readTransferHints(projectId, s, now).length, 20);
  assert.equal(readTransferHints(randomUUID(), s, now).length, 0);
  assert.equal(
    readTransferHints(projectId, s, now + 8 * 24 * 60 * 60 * 1000).length,
    0,
  );
  const before = s.getItem();
  const id = randomUUID();
  writeTransferHint(
    {
      version: 1,
      id,
      projectId,
      kind: "export",
      createdAt: now,
      request: { requestId: id, projectId, destinationPath: "/tmp/private" },
    },
    s,
    now,
  );
  assert.equal(s.getItem(), before);
  writeTransferHint(
    {
      version: 1,
      id,
      projectId,
      kind: "import",
      createdAt: now,
      request: {
        requestId: id,
        ownerProjectId: projectId,
        source: "user prose",
      },
    },
    s,
    now,
  );
  assert.equal(s.getItem(), before);
  writeTransferHint(
    {
      version: 1,
      id,
      projectId,
      kind: "import",
      createdAt: now,
      request: {
        requestId: id,
        ownerProjectId: projectId,
        intakeId: randomUUID(),
      },
    },
    s,
    now,
  );
  assert.equal(
    readTransferHints(projectId, s, now).some((row) => row.id === id),
    true,
  );
  discardTransferHint(id, s, now);
  assert.equal(
    readTransferHints(projectId, s, now).some((row) => row.id === id),
    false,
  );
  s.setItem(
    "",
    JSON.stringify([
      {
        version: 1,
        id,
        projectId,
        kind: "convert",
        createdAt: now,
        request: { requestId: id, projectId: randomUUID() },
      },
    ]),
  );
  assert.deepEqual(readTransferHints(projectId, s, now), []);
  s.setItem("", "x".repeat(256 * 1024 + 1));
  assert.deepEqual(readTransferHints(projectId, s, now), []);
});
test("recovery hint storage rejection cannot abort authoritative operation", () => {
  assert.doesNotThrow(() =>
    writeTransferHint(
      {
        version: 1,
        id: randomUUID(),
        projectId: randomUUID(),
        kind: "export",
        createdAt: Date.now(),
      },
      {
        getItem() {
          throw Error("denied");
        },
        setItem() {
          throw Error("full");
        },
      },
    ),
  );
});
