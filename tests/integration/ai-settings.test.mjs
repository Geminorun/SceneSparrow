import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { waitFor } from "../../scripts/processes.mjs";
const unknown = () => ({
  state: "unknown",
  source: "unknown",
  scope: "",
  observedAt: null,
});
test("authenticated global settings/session inference receipts use one real SDK call and never persist keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-ai-http-")),
    appData = join(directory, "application"),
    project = join(directory, "project");
  let calls = 0,
    lists = 0,
    inspectedWorkers = 0;
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    if (req.url === "/root/models") {
      lists++;
      res.writeHead(405, { "content-type": "application/json" });
      res.end('{"error":{"message":"no listing"}}');
      return;
    }
    calls++;
    if (req.url === "/b/chat/completions") {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(JSON.parse(body).model, "manual-B");
    } else {
      assert.equal(req.url, "/root/chat/completions");
      assert.equal(
        req.headers.authorization,
        "Bearer SYNTHETIC_HTTP_KEY_CANARY",
      );
      assert.equal(JSON.parse(body).model, "manually-entered-model");
    }
    if (process.platform === "linux") {
      // Managed PID namespaces may omit thread children listings. Inspect only
      // the known application worker executable; never print process data.
      const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
      let found = false;
      for (const id of ids) {
        const argv = await readFile(`/proc/${id}/cmdline`).catch(() =>
          Buffer.alloc(0),
        );
        if (!argv.includes(Buffer.from("workers/agent/src/entry.mjs")))
          continue;
        found = true;
        const env = await readFile(`/proc/${id}/environ`);
        for (const canary of [
          "SYNTHETIC_HTTP_KEY_CANARY",
          "ENVIRONMENT_CANARY_SHOULD_NOT_REACH_WORKER",
          token,
          "SCENESPARROW_PROJECT_DIR",
        ]) {
          assert.equal(argv.includes(Buffer.from(canary)), false);
          assert.equal(env.includes(Buffer.from(canary)), false);
        }
        assert.ok(argv.includes(Buffer.from("--use-system-ca")));
        assert.ok(argv.includes(Buffer.from("--use-env-proxy")));
        inspectedWorkers++;
      }
      assert.ok(
        found,
        "Expected the scoped agent worker while its local request is active",
      );
    }
    await new Promise((r) => setTimeout(r, 50));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: "OK" }, finish_reason: "stop", index: 0 },
        ],
      }),
    );
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${provider.address().port}/root`,
    token = randomBytes(32).toString("hex");
  let child,
    logs = "",
    base;
  const boot = async () => {
    const socket = createServer();
    await new Promise((r) => socket.listen(0, "127.0.0.1", r));
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    base = `http://127.0.0.1:${port}/v1`;
    child = spawn(
      `./target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
      [],
      {
        env: {
          ...process.env,
          SCENESPARROW_APP_DATA_DIR: appData,
          SCENESPARROW_PROJECT_DIR: project,
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_CORE_PORT: String(port),
          OPENAI_LOG: "debug",
          OPENAI_API_KEY: "ENVIRONMENT_CANARY_SHOULD_NOT_REACH_WORKER",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    await waitFor(
      `${base}/health`,
      { Authorization: `Bearer ${token}` },
      child,
    );
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGINT");
      await ended;
    }
  };
  const req = async (path, body, method) => {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    await boot();
    assert.equal((await fetch(`${base}/ai/settings`)).status, 401);
    assert.equal((await req("/ai/generate", { messages: [] })).status, 404);
    let view = (await req("/ai/settings")).data;
    assert.equal(view.credentialBackend, "session_only");
    const id = randomUUID(),
      s = view.settings;
    s.providers = [
      {
        id,
        label: "Local fixture",
        adapter: "openai_compatible",
        baseUrl: root,
        authMode: "bearer",
        credentialRevision: null,
        revision: 1,
      },
    ];
    s.models = [
      {
        providerId: id,
        id: "manually-entered-model",
        label: "Manual",
        capabilities: {
          images: unknown(),
          streaming: unknown(),
          nativeJson: unknown(),
        },
        contextTokens: null,
        outputTokens: null,
        tokenField: "max_tokens",
      },
    ];
    s.bindings = [
      {
        category: "text",
        providerId: id,
        modelId: "manually-entered-model",
        parameters: {
          temperatureMilli: null,
          maxOutputTokens: 64,
          requestStreaming: false,
          requestNativeJson: false,
        },
        revision: 1,
      },
    ];
    view = (
      await req("/ai/settings", { expectedRevision: 0, settings: s }, "PUT")
    ).data;
    assert.equal(calls, 0);
    const stale = await req(
      "/ai/settings",
      { expectedRevision: 0, settings: s },
      "PUT",
    );
    assert.equal(stale.status, 409);
    view = (
      await req("/ai/credentials", {
        expectedRevision: view.settings.revision,
        providerId: id,
        secret: "SYNTHETIC_HTTP_KEY_CANARY",
      })
    ).data;
    assert.equal(view.presentCredentialRevisions.length, 1);
    assert.equal(
      JSON.stringify(view).includes("SYNTHETIC_HTTP_KEY_CANARY"),
      false,
    );
    const listed = await req("/ai/models/discover", { providerId: id });
    assert.equal(listed.status, 422);
    assert.equal(lists, 1);
    assert.equal(calls, 0);
    const target = {
      providerId: id,
      modelId: "manually-entered-model",
      tokenField: "max_tokens",
    };
    const ready = (await req("/ai/connection-tests/prepare", target)).data;
    assert.equal(ready.configuration.model.id, "manually-entered-model");
    const action = {
      sessionId: view.sessionId,
      actionId: randomUUID(),
      fingerprint: ready.configuration.fingerprint,
      target,
    };
    const [one, two] = await Promise.all([
      req("/ai/connection-tests", action),
      req("/ai/connection-tests", action),
    ]);
    assert.equal(one.status, 200);
    assert.equal(one.data.status, "succeeded");
    assert.deepEqual(two.data, one.data);
    assert.equal(calls, 1);
    assert.equal(
      (
        await req("/ai/connection-tests", {
          ...action,
          fingerprint: "0".repeat(64),
        })
      ).status,
      409,
    );
    const beforeBinding = view.settings.bindings;
    const bid = randomUUID();
    const bsettings = structuredClone(view.settings);
    bsettings.providers.push({
      id: bid,
      label: "Selected B",
      adapter: "openai_compatible",
      baseUrl: root.replace("/root", "/b"),
      authMode: "none",
      credentialRevision: null,
      revision: 1,
    });
    view = (
      await req(
        "/ai/settings",
        { expectedRevision: view.settings.revision, settings: bsettings },
        "PUT",
      )
    ).data;
    const btarget = {
      providerId: bid,
      modelId: "manual-B",
      tokenField: "max_tokens",
    };
    const breadiness = (await req("/ai/connection-tests/prepare", btarget))
      .data;
    const btest = await req("/ai/connection-tests", {
      sessionId: view.sessionId,
      actionId: randomUUID(),
      fingerprint: breadiness.configuration.fingerprint,
      target: btarget,
    });
    assert.equal(btest.data.status, "succeeded");
    assert.equal(btest.data.providerRoot, root.replace("/root", "/b"));
    assert.equal(calls, 2);
    assert.deepEqual(
      (await req("/ai/settings")).data.settings.bindings,
      beforeBinding,
    );
    await stop();
    await boot();
    const lost = await req("/ai/configuration");
    assert.equal(lost.data.code, "CREDENTIAL_UNAVAILABLE");
    const uncertain = await req("/ai/connection-tests", action);
    assert.equal(uncertain.data.code, "TEST_STATUS_UNKNOWN");
    assert.equal(calls, 2);
    if (process.platform === "linux") assert.equal(inspectedWorkers, 2);
    assert.equal(logs.includes("SYNTHETIC_HTTP_KEY_CANARY"), false);
    assert.equal(logs.includes("ENVIRONMENT_CANARY"), false);
    const settings = await readFile(join(appData, "ai-settings.json"), "utf8");
    assert.equal(settings.includes("SYNTHETIC_HTTP_KEY_CANARY"), false);
    for (const file of await readdir(project)) {
      if (file.endsWith(".sqlite") || file.includes(".sqlite-")) {
        const bytes = await readFile(join(project, file));
        assert.equal(
          bytes.includes(Buffer.from("SYNTHETIC_HTTP_KEY_CANARY")),
          false,
        );
      }
    }
  } finally {
    await stop();
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    await rm(directory, { recursive: true, force: true });
  }
});
