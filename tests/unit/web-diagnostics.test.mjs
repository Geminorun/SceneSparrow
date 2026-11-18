import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  stat,
  appendFile,
  rm,
  unlink,
  mkdir,
  chmod,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { request } from "node:http";
import { spawn } from "node:child_process";
import {
  createDiagnostics,
  safeDiagnostic,
  collectChild,
  createGrantStore,
  createDiagnosticLimiter,
} from "../../apps/web/server/diagnostics.mjs";
import { createGateway, readOperator } from "../../apps/web/server/gateway.mjs";

const event = (extra = {}) => ({
  schemaVersion: 1,
  component: "core",
  level: "info",
  eventCode: "CORE_REQUEST",
  ...extra,
});
const fixture = async () =>
  mkdtemp(join(tmpdir(), "scenesparrow-diagnostics-"));

test("RD-A03 grants are one-time random hashed read credentials, expire and are boot-local", () => {
  let now = 1000;
  const grants = createGrantStore({ now: () => now });
  for (const body of [
    { ttlSeconds: 59 },
    { ttlSeconds: 3601 },
    { ttlSeconds: "900" },
    { url: "CANARY" },
    null,
    [],
  ])
    assert.throws(() => grants.mint(body), {
      code: "INVALID_DIAGNOSTICS_QUERY",
    });
  const first = grants.mint({});
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grants.authorize(first.token), first.grantId);
  assert.equal(JSON.stringify(grants.status()).includes(first.token), false);
  const second = grants.mint({ ttlSeconds: 60 });
  assert.throws(() => grants.authorize(first.token), { status: 401 });
  assert.throws(() => createGrantStore().authorize(second.token), {
    status: 401,
  });
  now += 60000;
  assert.throws(() => grants.authorize(second.token), {
    code: "DIAGNOSTICS_GRANT_EXPIRED",
  });
  assert.deepEqual(grants.revoke(), { revoked: true });
  const third = grants.mint({});
  grants.revoke();
  assert.throws(() => grants.authorize(third.token), { status: 401 });
});

test("RD-A04 creation, child ingestion and retained ingestion discard canary content", async () => {
  const directory = await fixture();
  const collector = createDiagnostics({ directory });
  const canary =
    "CANARY 密钥 /private/文稿.txt https://provider.invalid/key prompt password";
  try {
    assert.equal(
      safeDiagnostic({
        eventCode: "unknown",
        schemaVersion: 1,
        level: "info",
        component: "core",
      }),
      null,
    );
    const stream = new PassThrough();
    collectChild(stream, collector);
    stream.write(canary + "\n");
    stream.write("x".repeat(70000));
    stream.write("x\n");
    stream.write(
      JSON.stringify(
        event({
          message: canary,
          path: canary,
          projectId: canary,
          code: canary,
          traceId: canary,
          cfRay: canary,
        }),
      ) + "\n",
    );
    stream.write(
      JSON.stringify(
        event({ traceId: "a".repeat(32), cfRay: "0123456789abcdef-SJC" }),
      ) + "\n",
    );
    stream.end("partial CANARY");
    await once(stream, "end");
    await collector.flush();
    assert.equal(collector.status().droppedEvents, 3);
    const files = await readdir(directory);
    const file = join(directory, files[0]);
    await appendFile(
      file,
      JSON.stringify({
        ...event(),
        timestamp: new Date().toISOString(),
        bootId: "c".repeat(32),
        sequence: 10,
        message: canary,
      }) + "\n",
    );
    // A fresh collector discovers this retained record and sanitizes it again.
    const reader = createDiagnostics({ directory });
    try {
      const page = await reader.read(new URLSearchParams());
      assert.equal(page.events.length, 3);
      assert.equal(JSON.stringify(page).includes("CANARY"), false);
      assert.equal(page.events[0].code, "UNKNOWN");
      assert.equal(page.events[1].traceId, "a".repeat(32));
      assert.equal(page.events[1].cfRay, "0123456789abcdef-SJC");
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    } finally {
      await reader.close();
    }
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RD-A05 queue overflow, rotation, startup retention, corrupt tails and disk failure stay bounded", async () => {
  const directory = await fixture();
  let now = Date.now();
  const collector = createDiagnostics({
    directory,
    now: () => now,
    bounds: { queueEvents: 3, rotateBytes: 450, retainedBytes: 1000 },
  });
  try {
    for (let n = 0; n < 100; n++) collector.emit(event());
    assert.equal(collector.status().queueEvents, 3);
    assert.equal(collector.status().droppedEvents, 97);
    await collector.flush();
    for (let n = 0; n < 8; n++) {
      now++;
      collector.emit(event());
      await collector.flush();
    }
    assert.ok(collector.status().retained.bytes <= 1000);
    assert.ok((await readdir(directory)).length <= 3);
    assert.equal(
      collector.status().retained.until,
      new Date(now).toISOString(),
    );
    const lastFile = (await readdir(directory)).sort().at(-1);
    await appendFile(join(directory, lastFile), '{bad json}\n{"partial":');
    const reader = createDiagnostics({ directory, now: () => now });
    const page = await reader.read(new URLSearchParams());
    assert.equal(page.gap, true);
    assert.ok(page.events.length);
    assert.equal(JSON.stringify(page).includes("partial"), false);
    await reader.close();
    const expired = createDiagnostics({
      directory,
      now: () => now + 3 * 86400000 + 1,
    });
    await expired.flush();
    assert.equal((await readdir(directory)).length, 0);
    await expired.close();
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
  const failedDir = await fixture();
  const blocked = join(failedDir, "blocked");
  await writeFile(blocked, "file");
  const failed = createDiagnostics({ directory: blocked });
  failed.emit(event());
  await failed.flush();
  assert.equal(failed.status().collector, "DIAGNOSTICS_DEGRADED");
  await assert.rejects(failed.read(new URLSearchParams()), {
    code: "DIAGNOSTICS_UNAVAILABLE",
  });
  await failed.close();
  await rm(failedDir, { recursive: true, force: true });
});

test("RD-A03/RD-A05 cursors freeze windows, bind filters, detect rotation/restart and preserve old envelopes", async () => {
  const directory = await fixture();
  let now = Date.now();
  const collector = createDiagnostics({
    directory,
    now: () => now,
    bounds: { rotateBytes: 480 },
  });
  try {
    for (let n = 0; n < 5; n++) collector.emit(event({ level: "warn" }));
    await collector.flush();
    const page = await collector.read(
      new URLSearchParams({ limit: "2", level: "warn" }),
    );
    assert.equal(page.events.length, 2);
    assert.equal(page.truncated, true);
    assert.ok(page.nextCursor);
    now += 1000;
    collector.emit(event({ level: "warn" }));
    await collector.flush();
    const next = await collector.read(
      new URLSearchParams({ cursor: page.nextCursor, limit: "500" }),
    );
    assert.equal(next.events.length, 3);
    assert.equal(next.window.until, page.window.until);
    await assert.rejects(
      collector.read(
        new URLSearchParams({ cursor: page.nextCursor, level: "error" }),
      ),
      { status: 400 },
    );
    await assert.rejects(
      collector.read(
        new URLSearchParams({ cursor: page.nextCursor.slice(0, -1) + "!" }),
      ),
      { status: 409 },
    );
    for (const query of [
      { limit: "501" },
      { limit: "0" },
      { token: "CANARY" },
      { since: "yesterday" },
      { since: new Date(now - 86400001).toISOString() },
      { component: "provider URL" },
    ])
      await assert.rejects(collector.read(new URLSearchParams(query)), {
        status: 400,
      });
    const restarted = createDiagnostics({ directory, now: () => now });
    try {
      await assert.rejects(
        restarted.read(new URLSearchParams({ cursor: page.nextCursor })),
        { code: "CURSOR_EXPIRED" },
      );
      const old = await restarted.read(new URLSearchParams());
      assert.equal(old.events[0].bootId, page.events[0].bootId);
      assert.equal(old.events[0].sequence, page.events[0].sequence);
    } finally {
      await restarted.close();
    }
    const files = (await readdir(directory)).sort();
    await unlink(join(directory, files[1]));
    const gap = await collector.read(
      new URLSearchParams({ cursor: page.nextCursor }),
    );
    assert.equal(gap.gap, true);
    const concurrent = [
      collector.read(new URLSearchParams()),
      collector.read(new URLSearchParams()),
    ];
    await assert.rejects(collector.read(new URLSearchParams()), {
      status: 429,
    });
    await Promise.all(concurrent);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RD-A05 scans resume at record boundaries and read filesystem failures stay closed", async () => {
  const directory = await fixture();
  const collector = createDiagnostics({
    directory,
    bounds: { scanBytes: 256 },
  });
  try {
    for (let n = 0; n < 5; n++) collector.emit(event());
    await collector.flush();
    let cursor,
      seen = [];
    for (let n = 0; n < 10; n++) {
      const page = await collector.read(
        new URLSearchParams(cursor ? { cursor } : {}),
      );
      seen.push(...page.events.map((record) => record.sequence));
      if (!page.nextCursor) break;
      assert.equal(page.truncated, true);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    const builds = [collector.bundle(new URLSearchParams())];
    await assert.rejects(collector.bundle(new URLSearchParams()), {
      status: 429,
    });
    await Promise.all(builds);
    const file = join(directory, (await readdir(directory))[0]);
    await unlink(file);
    await mkdir(file);
    await assert.rejects(collector.read(new URLSearchParams()), {
      code: "DIAGNOSTICS_UNAVAILABLE",
      status: 503,
    });
    assert.equal(collector.status().collector, "DIAGNOSTICS_DEGRADED");
    assert.ok(collector.status().errors > 0);
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RD-A05 idle retention runs without new events and restores private file permissions", async () => {
  const directory = await fixture();
  let now = Date.now();
  const original = createDiagnostics({ directory, now: () => now });
  original.emit(event());
  await original.flush();
  await original.close();
  const file = join(directory, (await readdir(directory))[0]);
  await chmod(file, 0o644);
  const collector = createDiagnostics({
    directory,
    now: () => now,
    bounds: { maintenanceMs: 5 },
  });
  try {
    await collector.flush();
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    now += 3 * 86400000 + 1;
    const deadline = Date.now() + 1000;
    while ((await readdir(directory)).length && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(collector.status().retained.bytes, 0);
    assert.equal(collector.status().collector, "ready");
  } finally {
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RD-A05 timed-out reads mark degradation and retain both occupied disk-read slots", async () => {
  const directory = await fixture();
  let stalled = false,
    entered = 0;
  const releases = [];
  const collector = createDiagnostics({
    directory,
    bounds: { readMs: 30 },
    openFile: async (...args) => {
      const handle = await open(...args);
      if (args[1] !== "r" || !stalled) return handle;
      return {
        close: () => handle.close(),
        read: async (...readArgs) => {
          entered++;
          await new Promise((done) => releases.push(done));
          return handle.read(...readArgs);
        },
      };
    },
  });
  try {
    collector.emit(event());
    await collector.flush();
    stalled = true;
    const first = collector.read(new URLSearchParams()),
      second = collector.read(new URLSearchParams());
    await Promise.all([
      assert.rejects(first, { code: "DIAGNOSTICS_UNAVAILABLE", status: 503 }),
      assert.rejects(second, { code: "DIAGNOSTICS_UNAVAILABLE", status: 503 }),
    ]);
    assert.equal(entered, 2);
    assert.equal(collector.status().collector, "DIAGNOSTICS_DEGRADED");
    assert.equal(collector.status().errors, 2);
    await assert.rejects(collector.read(new URLSearchParams()), {
      code: "DIAGNOSTICS_RATE_LIMITED",
      status: 429,
    });
  } finally {
    stalled = false;
    for (const release of releases) release();
    await new Promise((done) => setTimeout(done, 10));
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RD-A05 maintenance waits for the writer and does not delete a file during append", async () => {
  const directory = await fixture();
  let now = Date.now(),
    block = false,
    entered;
  const started = new Promise((done) => {
    entered = done;
  });
  let release;
  const collector = createDiagnostics({
    directory,
    now: () => now,
    bounds: { maintenanceMs: 5 },
    openFile: async (...args) => {
      const handle = await open(...args);
      if (args[1] !== "a" || !block) return handle;
      return {
        chmod: (...params) => handle.chmod(...params),
        close: () => handle.close(),
        writeFile: async (...params) => {
          entered();
          await new Promise((done) => {
            release = done;
          });
          return handle.writeFile(...params);
        },
      };
    },
  });
  try {
    collector.emit(event());
    await collector.flush();
    block = true;
    collector.emit(event());
    await started;
    now += 3 * 86400000 + 1;
    await new Promise((done) => setTimeout(done, 25));
    assert.equal((await readdir(directory)).length, 1);
    block = false;
    release();
    await collector.flush();
    const deadline = Date.now() + 1000;
    while ((await readdir(directory)).length && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 5));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(collector.status().errors, 0);
  } finally {
    release?.();
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "RD-A05 stalled writes close by deadline and child exits naturally without diagnostic scheduling",
  { timeout: 5000 },
  async () => {
    const moduleUrl = new URL(
      "../../apps/web/server/diagnostics.mjs",
      import.meta.url,
    ).href;
    const directory = await fixture();
    const run = (code) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", code],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "",
          errors = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        const deadline = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error("Diagnostic scheduling prevented natural child exit"),
          );
        }, 1500);
        child.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(deadline);
          resolve({ code, signal, output, errors });
        });
      });
    try {
      const stalled = await run(
        `import {createDiagnostics} from ${JSON.stringify(moduleUrl)};import {open} from 'node:fs/promises';let entered;const started=new Promise(done=>entered=done);const collector=createDiagnostics({directory:${JSON.stringify(directory)},bounds:{maintenanceMs:5},openFile:async(...args)=>{const handle=await open(...args);if(args[1]!=='a')return handle;return{chmod:(...params)=>handle.chmod(...params),close:()=>handle.close(),writeFile:async()=>{entered();await new Promise(()=>{});}};}});collector.emit(${JSON.stringify(event())});await started;for(let n=0;n<2000;n++)collector.emit(${JSON.stringify(event())});const before=Date.now();await collector.close(25);console.log(JSON.stringify({closed:true,elapsed:Date.now()-before,queued:collector.status().queueEvents}));`,
      );
      assert.equal(stalled.code, 0, stalled.errors);
      assert.equal(stalled.signal, null);
      const status = JSON.parse(stalled.output);
      assert.equal(status.closed, true);
      assert.ok(status.elapsed < 500);
      assert.equal(status.queued, 0);
      const idle = await run(
        `import {createDiagnostics} from ${JSON.stringify(moduleUrl)};const collector=createDiagnostics({directory:${JSON.stringify(directory)},bounds:{maintenanceMs:5}});await collector.flush();console.log('idle');`,
      );
      assert.equal(idle.code, 0, idle.errors);
      assert.equal(idle.output.trim(), "idle");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("RD-A05 fixed rate buckets bound credential, global, grant, client and bundle operations", () => {
  let now = 0;
  const rate = createDiagnosticLimiter({ now: () => now });
  for (let n = 0; n < 30; n++) rate("read", "operator");
  assert.throws(() => rate("read", "operator"), { status: 429 });
  for (let n = 0; n < 30; n++) rate("read", "grant-id");
  assert.throws(() => rate("read", "new-grant-id"), { status: 429 });
  for (const [kind, max] of [
    ["grant", 6],
    ["bundle", 2],
    ["client", 30],
  ]) {
    for (let n = 0; n < max; n++) rate(kind);
    assert.throws(() => rate(kind), { status: 429 });
  }
  now += 60000;
  rate("read", "operator");
  rate("grant");
  rate("bundle");
  rate("client");
});

test("RD-A01/A02/A03/A04 gateway HTML, read-only grant scope, early diagnostics and safe trace exports", async () => {
  const directory = await fixture();
  const logs = join(directory, "logs");
  const credential = "operator:synthetic-password";
  const origin = "https://scene.example";
  await writeFile(join(directory, "auth"), credential);
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><title>App</title>",
  );
  let ready = false;
  const collector = createDiagnostics({
    directory: logs,
    coreAvailable: () => ready,
  });
  const gateway = await createGateway({
    origin,
    operator: await readOperator(join(directory, "auth")),
    staticRoot: directory,
    corePort: 1,
    token: "CANARY-core",
    ready: () => ready,
    diagnostics: collector,
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const basic = `Basic ${Buffer.from(credential).toString("base64")}`;
  const send = (
    path,
    { method = "GET", authorization = basic, headers = {}, body } = {},
  ) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: gateway.server.address().port,
          path,
          method,
          headers: { host: "scene.example", authorization, ...headers },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  try {
    const navigation = {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "cross-site",
      accept: "text/html",
    };
    const unauthorized = await send("/", {
      authorization: "",
      headers: navigation,
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers["content-type"], /^text\/html/);
    assert.match(unauthorized.headers["www-authenticate"], /^Basic/);
    assert.match(unauthorized.body, /<!doctype html>/);
    assert.match(
      unauthorized.headers["x-scenesparrow-trace-id"],
      /^[a-f0-9]{32}$/,
    );
    assert.equal(
      (
        await send("/readyz", {
          authorization: "",
          headers: { host: "127.0.0.1" },
        })
      ).status,
      503,
    );
    assert.equal((await send("/")).status, 503);
    assert.equal(
      (await send("/diagnostics", { headers: navigation })).status,
      200,
    );
    const html = await send("/diagnostics");
    assert.match(html.headers["content-security-policy"], /default-src 'none'/);
    assert.doesNotMatch(html.body, /localStorage|sessionStorage|https:\/\//);
    assert.equal((await send("/diagnostics/v1/status")).status, 200);
    for (const headers of [{ origin: "" }, { "sec-fetch-site": "" }])
      assert.equal(
        (await send("/diagnostics/v1/status", { headers })).status,
        403,
      );
    assert.equal(
      JSON.parse((await send("/diagnostics/v1/status")).body).coreAvailable,
      false,
    );
    const mint = await send("/diagnostics/v1/access-grants", {
      method: "POST",
      headers: { origin },
      body: "{}",
    });
    assert.equal(mint.status, 201);
    const grant = JSON.parse(mint.body);
    const bearer = `Bearer ${grant.token}`;
    const status = await send("/diagnostics/v1/status", {
      authorization: bearer,
    });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).activeGrant, undefined);
    for (const path of [
      "/",
      "/diagnostics",
      "/api/v1/project",
      "/api/v1/project/quiesce",
      "/diagnostics/v1/access-grants",
      "/diagnostics/v1/status/extra",
    ])
      assert.equal((await send(path, { authorization: bearer })).status, 403);
    assert.equal(
      (
        await send("/diagnostics/v1/status", {
          authorization: bearer,
          method: "HEAD",
        })
      ).status,
      403,
    );
    const invalid = await send("/", {
      authorization: "Bearer invalid",
      headers: navigation,
    });
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers["content-type"], /^application\/json/);
    assert.match(invalid.headers["www-authenticate"], /^Bearer/);
    assert.equal(
      (await send("/diagnostics/v1/status?token=" + grant.token)).status,
      400,
    );
    assert.equal(
      (await send("/diagnostics/v1/logs?token=" + grant.token)).status,
      400,
    );
    assert.equal(
      (
        await send("/diagnostics/v1/logs", {
          headers: { origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send("/diagnostics/v1/access-grants/revoke", {
          method: "POST",
          body: "{}",
        })
      ).status,
      403,
    );
    const client = {
      schemaVersion: 1,
      component: "client",
      level: "warn",
      eventCode: "CLIENT_FAILURE",
      stage: "bootstrap",
      routeId: "document",
      code: "BOOTSTRAP_FAILED",
      appBuild: "unknown",
    };
    assert.equal(
      (
        await send("/diagnostics/v1/client-events", {
          method: "POST",
          headers: { origin },
          body: JSON.stringify(client),
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await send("/diagnostics/v1/client-events", {
          method: "POST",
          headers: { origin },
          body: JSON.stringify({ ...client, message: "CANARY-secret" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await send("/diagnostics/v1/client-events", {
          authorization: bearer,
          method: "POST",
          headers: { origin },
          body: JSON.stringify(client),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send("/diagnostics/v1/client-events", {
          method: "POST",
          headers: { origin },
          body: "x".repeat(4097),
        })
      ).status,
      413,
    );
    await collector.flush();
    const bundle = await send("/diagnostics/v1/bundle", {
      authorization: bearer,
    });
    assert.equal(bundle.status, 200);
    assert.ok(Buffer.byteLength(bundle.body) < 1048576);
    assert.doesNotMatch(bundle.body, /CANARY|synthetic-password/);
    assert.equal(bundle.body.includes(grant.token), false);
    const trace = "d".repeat(32);
    const traced = await send("/diagnostics/v1/status", {
      headers: { "x-scenesparrow-trace-id": trace, "cf-ray": "CANARY invalid" },
    });
    assert.notEqual(traced.headers["x-scenesparrow-trace-id"], trace);
    assert.equal(
      (
        await send("/diagnostics/v1/access-grants/revoke", {
          method: "POST",
          headers: { origin },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (await send("/diagnostics/v1/status", { authorization: bearer })).status,
      401,
    );
    ready = true;
    assert.equal(
      (
        await send("/readyz", {
          authorization: "",
          headers: { host: "127.0.0.1" },
        })
      ).status,
      200,
    );
    assert.match(
      (await send("/", { headers: navigation })).body,
      /<!doctype html>/,
    );
  } finally {
    await gateway.close();
    await collector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
