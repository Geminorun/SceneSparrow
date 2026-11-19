import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerNativePackageIpc } from "../../apps/desktop/src/native-package-ipc.ts";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(overrides = {}, checks) {
  const handlers = new Map(),
    calls = [];
  const archiveId = randomUUID();
  let selected = 0,
    current = {},
    denied = false;
  const session = {
    core: current,
    request: async (path, body, bytes, headers) => {
      calls.push({ path, body, bytes: bytes && Buffer.from(bytes), headers });
      if (path.includes("/saves/")) throw Error("PACKAGE_NOT_FOUND");
      if (path.includes("/operations/"))
        return {
          state: "succeeded",
          archive: {
            archiveId,
            filename: "project.zip",
            expiresAt: Date.now() + 10000,
          },
        };
      if (path.includes("save-new"))
        return {
          requestId: body.requestId,
          outcome: "saved",
          filename: "project.zip",
        };
      return {};
    },
  };
  const host = {
    platform: "linux",
    checkSender() {
      if (denied) throw Error("ORIGIN_DENIED");
    },
    session: () => session,
    current: (owned) => owned.core === current,
    chooseIntake: async () => null,
    chooseSave: async () => {
      selected++;
      return "/tmp/private/project.zip";
    },
    ...overrides,
  };
  const owner = registerNativePackageIpc(
    { handle: (name, fn) => handlers.set(name, fn) },
    host,
    checks,
  );
  return {
    archiveId,
    calls,
    host,
    session,
    owner,
    invoke: (kind, request) =>
      handlers.get(`native-package:${kind}`)({}, request),
    stale() {
      current = {};
    },
    deny() {
      denied = true;
    },
    get selected() {
      return selected;
    },
  };
}
test("native package bridge denies sender and closed renderer paths/overrides before chooser", async () => {
  const f = fixture();
  f.deny();
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).code,
    "ORIGIN_DENIED",
  );
  const g = fixture();
  for (const extra of [
    { path: "/tmp/no" },
    { destinationPath: "/tmp/no" },
    { limit: 9 },
    { hash: "a" },
  ])
    assert.equal(
      (
        await g.invoke("save", {
          requestId: randomUUID(),
          archiveId: g.archiveId,
          ...extra,
        })
      ).code,
      "INVALID_REQUEST",
    );
  assert.equal(g.selected, 0);
  assert.equal(g.calls.length, 0);
});
test("native save captures original core before chooser and does not retarget a late result", async () => {
  const gate = deferred(),
    f = fixture({ chooseSave: () => gate.promise });
  const result = f.invoke("save", {
    requestId: randomUUID(),
    archiveId: f.archiveId,
  });
  await new Promise((r) => setImmediate(r));
  f.stale();
  gate.resolve("/tmp/private/later.zip");
  assert.equal((await result).code, "CAPABILITY_EXPIRED");
  assert.equal(
    f.calls.filter((call) => call.path.includes("save-new")).length,
    0,
  );
});
test("native save unknown keeps original request and never opens chooser or writes again", async () => {
  const f = fixture(),
    send = f.session.request;
  f.session.request = async (...args) => {
    if (args[0].includes("save-new")) throw Error("lost ACK");
    return send(...args);
  };
  const request = { requestId: randomUUID(), archiveId: f.archiveId };
  assert.equal((await f.invoke("save", request)).data.outcome, "unknown");
  assert.equal((await f.invoke("save", request)).data.outcome, "unknown");
  assert.equal(f.selected, 1);
});
test("native save refuses expired artifact before chooser and keeps definitive errors distinct", async () => {
  const f = fixture();
  f.session.request = async (path) => {
    if (path.includes("/saves/")) throw Error("PACKAGE_NOT_FOUND");
    return {
      state: "succeeded",
      archive: {
        archiveId: f.archiveId,
        filename: "project.zip",
        expiresAt: 1,
      },
    };
  };
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).code,
    "PACKAGE_EXPIRED",
  );
  assert.equal(f.selected, 0);
  const g = fixture(),
    send = g.session.request;
  g.session.request = async (...args) => {
    if (args[0].includes("save-new")) throw Error("SOURCE_PATH_UNSAFE");
    return send(...args);
  };
  assert.equal(
    (
      await g.invoke("save", {
        requestId: randomUUID(),
        archiveId: g.archiveId,
      })
    ).code,
    "SOURCE_PATH_UNSAFE",
  );
});
test("native ordinary chooser cancellation and named intake cancellation settle without upload", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.invoke("intake", {
        requestId: randomUUID(),
        ownerProjectId: randomUUID(),
      })
    ).data.outcome,
    "cancelled",
  );
  const gate = deferred(),
    g = fixture({ chooseIntake: () => gate.promise });
  const request = { requestId: randomUUID(), ownerProjectId: randomUUID() };
  const pending = g.invoke("intake", request),
    cancelling = g.invoke("cancel-intake", { requestId: request.requestId });
  gate.resolve("/tmp/never-opened.zip");
  assert.equal((await pending).code, "PACKAGE_CANCELLED");
  assert.equal((await cancelling).ok, true);
  assert.equal(g.calls.length, 0);
});
test("native terminal receipt cache does not exhaust new chooser admission after historical cancels", async () => {
  const f = fixture();
  for (let n = 0; n < 80; n++)
    assert.equal(
      (
        await f.invoke("intake", {
          requestId: randomUUID(),
          ownerProjectId: randomUUID(),
        })
      ).data.outcome,
      "cancelled",
    );
});
test("native selected regular file hashes/uploads in 64KiB reads with exact metadata and safe facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-native-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "sample.zip"),
    bytes = Buffer.alloc(1024 * 1024 + 17, 123);
  await writeFile(path, bytes);
  const f = fixture({ chooseIntake: async () => path });
  let current;
  f.session.request = async (route, body, chunk, headers) => {
    if (body && route.endsWith("package-intakes")) {
      assert.equal(body.hash, createHash("sha256").update(bytes).digest("hex"));
      current = {
        intakeId: body.requestId,
        ownerProjectId: body.ownerProjectId,
        filename: body.filename,
        length: body.length,
        hash: body.hash,
        receivedBytes: 0,
        revision: 1,
        state: "open",
      };
      return current;
    }
    if (chunk) {
      assert.ok(chunk.length <= 64 * 1024);
      const offset = Number(headers["x-scenesparrow-chunk-offset"]);
      assert.equal(
        createHash("sha256").update(chunk).digest("hex"),
        headers["x-scenesparrow-chunk-sha256"],
      );
      assert.deepEqual(
        Buffer.from(chunk),
        bytes.subarray(offset, offset + chunk.length),
      );
      current.receivedBytes += chunk.length;
      return {
        intakeId: current.intakeId,
        offset,
        length: chunk.length,
        hash: headers["x-scenesparrow-chunk-sha256"],
        acknowledgedEnd: current.receivedBytes,
      };
    }
    return current;
  };
  const result = await f.invoke("intake", {
    requestId: randomUUID(),
    ownerProjectId: randomUUID(),
  });
  assert.equal(result.data.intake.receivedBytes, bytes.length);
  assert.equal(result.data.intake.filename, "sample.zip");
  assert.equal(JSON.stringify(result).includes(dir), false);
  const link = join(dir, "link.zip");
  await symlink(path, link);
  const g = fixture({ chooseIntake: async () => link });
  assert.equal(
    (
      await g.invoke("intake", {
        requestId: randomUUID(),
        ownerProjectId: randomUUID(),
      })
    ).code,
    "PACKAGE_FILE_CHANGED",
  );
  const large = join(dir, "large.zip");
  await writeFile(large, "");
  await truncate(large, 8 * 1024 ** 3 + 1);
  const h = fixture({ chooseIntake: async () => large });
  assert.equal(
    (
      await h.invoke("intake", {
        requestId: randomUUID(),
        ownerProjectId: randomUUID(),
      })
    ).code,
    "PACKAGE_SIZE_LIMIT",
  );
});

test("project close settles a pending native chooser without waiting for its late OS result", async () => {
  const gate = deferred(),
    f = fixture({ chooseSave: () => gate.promise });
  const pending = f.invoke("save", {
    requestId: randomUUID(),
    archiveId: f.archiveId,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await f.owner.settle();
  assert.equal((await pending).code, "PACKAGE_CANCELLED");
  gate.resolve("/tmp/late-destination.zip");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.calls.filter((call) => call.path.includes("save-new")).length,
    0,
  );
});
test("native save chooser cancellation or exists permits a new explicit delivery ID while unknown stays original", async () => {
  let choices = 0;
  const f = fixture({
    chooseSave: async () => (++choices === 1 ? null : "/tmp/new-file.zip"),
  });
  const first = await f.invoke("save", {
    requestId: randomUUID(),
    archiveId: f.archiveId,
  });
  assert.equal(first.data.outcome, "cancelled");
  const second = await f.invoke("save", {
    requestId: randomUUID(),
    archiveId: f.archiveId,
  });
  assert.equal(second.data.outcome, "saved");
  assert.equal(choices, 2);
  const g = fixture(),
    send = g.session.request;
  let write = 0;
  g.session.request = async (...args) => {
    if (args[0].includes("save-new") && ++write === 1)
      return {
        requestId: args[1].requestId,
        filename: "project.zip",
        outcome: "exists",
      };
    return send(...args);
  };
  assert.equal(
    (
      await g.invoke("save", {
        requestId: randomUUID(),
        archiveId: g.archiveId,
      })
    ).data.outcome,
    "exists",
  );
  assert.equal(
    (
      await g.invoke("save", {
        requestId: randomUUID(),
        archiveId: g.archiveId,
      })
    ).data.outcome,
    "saved",
  );
  assert.equal(g.selected, 2);
});

test("named native delivery lookup on a cold main cache is read-only and never chooses or saves", async () => {
  const f = fixture();
  const request = { requestId: randomUUID(), archiveId: f.archiveId };
  f.session.request = async (path) => {
    f.calls.push({ path });
    return {
      requestId: request.requestId,
      filename: "safe.zip",
      outcome: "saved",
    };
  };
  assert.equal((await f.invoke("save-status", request)).data.outcome, "saved");
  assert.equal(f.selected, 0);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    [
      `/native/project/packages/${request.archiveId}/saves/${request.requestId}`,
    ],
  );
  f.stale();
  assert.equal(
    (await f.invoke("save-status", request)).code,
    "CAPABILITY_EXPIRED",
  );
  assert.equal(f.calls.length, 1);
});

test("read-only original Saved reconciliation retires unknown admission for the same captured core only", async () => {
  const f = fixture(),
    send = f.session.request,
    requests = [];
  const written = new Set();
  f.session.request = async (...args) => {
    if (args[0].includes("/saves/")) {
      if (!written.has(args[0].split("/").at(-1)))
        throw Error("PACKAGE_NOT_FOUND");
      return {
        requestId: args[0].split("/").at(-1),
        filename: "safe.zip",
        outcome: "saved",
      };
    }
    if (args[0].endsWith("save-new")) {
      written.add(args[1].requestId);
      throw Error("lost ACK");
    }
    return send(...args);
  };
  for (let n = 0; n < 8; n++) {
    const request = { requestId: randomUUID(), archiveId: f.archiveId };
    requests.push(request);
    assert.equal((await f.invoke("save", request)).data.outcome, "unknown");
  }
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).code,
    "PACKAGE_BUSY",
  );
  for (const request of requests)
    assert.equal(
      (await f.invoke("save-status", request)).data.outcome,
      "saved",
    );
  assert.equal(f.selected, 8);
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).data.outcome,
    "unknown",
  );
  assert.equal(f.selected, 9);
  assert.equal((await f.invoke("save", requests[0])).data.outcome, "saved");
  assert.equal(f.selected, 9);
});

test("native cancel retains its original backend control after lost ACK and rejects save IDs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "scenesparrow-native-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "cancel.zip");
  await writeFile(path, Buffer.alloc(128 * 1024, 7));
  let picks = 0;
  const f = fixture({
      chooseIntake: async () => {
        picks++;
        return path;
      },
    }),
    started = deferred(),
    controls = [];
  let intake;
  f.session.request = async (route, body, bytes, headers, signal) => {
    if (route.endsWith("package-intakes")) {
      intake = {
        intakeId: body.requestId,
        ownerProjectId: body.ownerProjectId,
        receivedBytes: 0,
        revision: 1,
        state: "open",
        filename: body.filename,
        length: body.length,
        hash: body.hash,
      };
      return intake;
    }
    if (bytes) {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Error("PACKAGE_CANCELLED")),
          { once: true },
        ),
      );
    }
    if (route.endsWith("/control")) {
      controls.push(body);
      if (controls.length === 1) throw Error("lost cancel ACK");
      return { ...intake, state: "cancelled", revision: 2 };
    }
    return intake;
  };
  const request = { requestId: randomUUID(), ownerProjectId: randomUUID() },
    selecting = f.invoke("intake", request);
  await started.promise;
  const first = f.invoke("cancel-intake", { requestId: request.requestId }),
    duplicate = f.invoke("cancel-intake", { requestId: request.requestId });
  assert.equal((await first).code, "CORE_UNAVAILABLE");
  assert.equal((await duplicate).code, "CORE_UNAVAILABLE");
  assert.equal((await selecting).code, "PACKAGE_CANCELLED");
  assert.equal(controls.length, 1);
  assert.equal(
    (await f.invoke("cancel-intake", { requestId: request.requestId })).ok,
    true,
  );
  assert.equal(controls.length, 2);
  assert.deepEqual(controls[0], controls[1]);
  assert.equal(picks, 1);
  const g = fixture(),
    saving = { requestId: randomUUID(), archiveId: g.archiveId };
  await g.invoke("save", saving);
  assert.equal(
    (await g.invoke("cancel-intake", { requestId: saving.requestId })).code,
    "INVALID_REQUEST",
  );
});

test("read-only lookup can return a captured benign chooser cancellation without touching core or choosing again", async () => {
  const f = fixture({ chooseSave: async () => null }),
    request = { requestId: randomUUID(), archiveId: randomUUID() };
  request.archiveId = f.archiveId;
  assert.equal((await f.invoke("save", request)).data.outcome, "cancelled");
  const before = f.calls.length;
  assert.equal(
    (await f.invoke("save-status", request)).data.outcome,
    "cancelled",
  );
  assert.equal(f.calls.length, before);
  f.stale();
  assert.equal(
    (await f.invoke("save-status", request)).code,
    "CAPABILITY_EXPIRED",
  );
  assert.equal(f.calls.length, before);
});

test("cold-cache Save returns original saved or unknown receipt before availability or chooser, even when archive is gone", async () => {
  for (const outcome of ["saved", "unknown"]) {
    const f = fixture(),
      request = { requestId: randomUUID(), archiveId: f.archiveId };
    let reads = 0;
    f.session.request = async (path) => {
      reads++;
      assert.equal(
        path,
        `/native/project/packages/${request.archiveId}/saves/${request.requestId}`,
      );
      return {
        requestId: request.requestId,
        filename: "original.zip",
        outcome,
      };
    };
    assert.equal((await f.invoke("save", request)).data.outcome, outcome);
    assert.equal(f.selected, 0);
    assert.equal(reads, 1);
    assert.equal((await f.invoke("save", request)).data.outcome, outcome);
    assert.equal(f.selected, 0);
    assert.equal(reads, 1);
  }
  const f = fixture();
  f.session.request = async () => {
    throw Error("unknown lookup response");
  };
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).code,
    "PACKAGE_SAVE_NOT_STARTED",
  );
  assert.equal(f.selected, 0);
});

test("never-published native precheck and intake IO failures release active admission", async () => {
  const f = fixture(),
    original = f.session.request;
  f.session.request = async () => {
    throw Error("transient precheck");
  };
  for (let n = 0; n < 12; n++)
    assert.equal(
      (
        await f.invoke("save", {
          requestId: randomUUID(),
          archiveId: f.archiveId,
        })
      ).code,
      "PACKAGE_SAVE_NOT_STARTED",
    );
  assert.equal(f.selected, 0);
  f.session.request = original;
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).data.outcome,
    "saved",
  );
  const g = fixture({
    chooseIntake: async () =>
      join(tmpdir(), `missing-native-package-${randomUUID()}.zip`),
  });
  for (let n = 0; n < 12; n++)
    assert.equal(
      (
        await g.invoke("intake", {
          requestId: randomUUID(),
          ownerProjectId: randomUUID(),
        })
      ).code,
      "CORE_UNAVAILABLE",
    );
  g.host.chooseIntake = async () => null;
  assert.equal(
    (
      await g.invoke("intake", {
        requestId: randomUUID(),
        ownerProjectId: randomUUID(),
      })
    ).data.outcome,
    "cancelled",
  );
});
test("original NotFound lookup cannot release an actually dispatched unknown save", async () => {
  const f = fixture(),
    send = f.session.request;
  f.session.request = async (...args) => {
    if (args[0].endsWith("/save-new")) throw Error("lost POST response");
    return send(...args);
  };
  const requests = Array.from({ length: 8 }, () => ({
    requestId: randomUUID(),
    archiveId: f.archiveId,
  }));
  for (const request of requests)
    assert.equal((await f.invoke("save", request)).data.outcome, "unknown");
  assert.equal(
    (await f.invoke("save-status", requests[0])).code,
    "PACKAGE_NOT_FOUND",
  );
  assert.equal(
    (
      await f.invoke("save", {
        requestId: randomUUID(),
        archiveId: f.archiveId,
      })
    ).code,
    "PACKAGE_BUSY",
  );
  assert.equal((await f.invoke("save", requests[0])).data.outcome, "unknown");
  assert.equal(f.selected, 8);
});
test("held native intake stamp rechecks size and baseline after a same-inode open race", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-intake-growth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "grow.zip");
  await writeFile(path, "1234");
  const f = fixture(
    { chooseIntake: async () => path },
    {
      intakeByteLimit: 8,
      beforeIntakeOpen: async () => {
        await truncate(path, 9);
      },
    },
  );
  const result = await f.invoke("intake", {
    requestId: randomUUID(),
    ownerProjectId: randomUUID(),
  });
  assert.equal(result.code, "PACKAGE_SIZE_LIMIT");
  assert.equal(f.calls.length, 0);
});
