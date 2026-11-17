import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitFor } from "../../scripts/processes.mjs";
const unknown = () => ({
  state: "unknown",
  source: "unknown",
  scope: "",
  observedAt: null,
});
for (const encrypted of [false, true]) {
  test(`authenticated global settings/${encrypted ? "encrypted" : "session"} inference receipts survive safely without plaintext keys`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "scenesparrow-ai-http-")),
      appData = join(directory, "application"),
      project = join(directory, "project");
    const masterKeyFile = join(directory, "master-key");
    const masterEncoded = randomBytes(32).toString("base64");
    await writeFile(masterKeyFile, masterEncoded, { mode: 0o444 });
    let keyLocator = encrypted ? masterKeyFile : undefined;
    let expectedKey = "SYNTHETIC_HTTP_KEY_CANARY";
    let listStatus = 405,
      listCode = null;
    let calls = 0,
      lists = 0,
      inspectedWorkers = 0;
    const provider = createServer(async (req, res) => {
      let body = "";
      for await (const bytes of req) body += bytes;
      if (req.url === "/root/models") {
        lists++;
        res.writeHead(listStatus, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: listCode,
              message: "SECRET_LISTING_CANARY private provider body",
            },
          }),
        );
        return;
      }
      calls++;
      if (req.url === "/b/chat/completions") {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(JSON.parse(body).model, "manual-B");
      } else {
        assert.equal(req.url, "/root/chat/completions");
        assert.equal(req.headers.authorization, `Bearer ${expectedKey}`);
        assert.equal(JSON.parse(body).model, "manually-entered-model");
      }
      if (process.platform === "linux") {
        // Thread children listings vary across PID namespaces. Read parent IDs
        // instead, excluding workers owned by concurrently running test cores.
        const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
        let found = false;
        for (const id of ids) {
          const status = await readFile(`/proc/${id}/status`, "utf8").catch(
            () => "",
          );
          if (status.match(/^PPid:[ \t]+(\d+)$/m)?.[1] !== String(child.pid))
            continue;
          const argv = await readFile(`/proc/${id}/cmdline`).catch(() =>
            Buffer.alloc(0),
          );
          const args = argv.toString("utf8").split("\0");
          if (!args.some((arg) => arg.endsWith("/workers/agent/src/entry.mjs")))
            continue;
          found = true;
          const env = await readFile(`/proc/${id}/environ`);
          for (const canary of [
            "SYNTHETIC_HTTP_KEY_CANARY",
            "ENVIRONMENT_CANARY_SHOULD_NOT_REACH_WORKER",
            token,
            "SCENESPARROW_PROJECT_DIR",
            "SCENESPARROW_AI_MASTER_KEY_FILE",
            masterKeyFile,
            masterEncoded,
          ]) {
            assert.equal(argv.includes(Buffer.from(canary)), false);
            assert.equal(env.includes(Buffer.from(canary)), false);
          }
          assert.ok(args.includes("--use-system-ca"));
          assert.ok(args.includes("--use-env-proxy"));
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
      const env = {
        ...process.env,
        SCENESPARROW_APP_DATA_DIR: appData,
        SCENESPARROW_PROJECT_DIR: project,
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_CORE_PORT: String(port),
        OPENAI_LOG: "debug",
        OPENAI_API_KEY: "ENVIRONMENT_CANARY_SHOULD_NOT_REACH_WORKER",
      };
      delete env.SCENESPARROW_AI_MASTER_KEY_FILE;
      if (keyLocator !== undefined)
        env.SCENESPARROW_AI_MASTER_KEY_FILE = keyLocator;
      child = spawn(
        `./target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
        [],
        {
          env,
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
      let unrelatedWorker;
      if (encrypted && process.platform === "linux") {
        // Keep a foreign worker alive throughout every request. A whole-host
        // scan must not depend on other integration files happening to be idle.
        unrelatedWorker = spawn(
          process.execPath,
          [
            "--use-system-ca",
            "--use-env-proxy",
            fileURLToPath(
              new URL("../../workers/agent/src/entry.mjs", import.meta.url),
            ),
          ],
          {
            env: { PATH: process.env.PATH },
            stdio: ["pipe", "ignore", "ignore"],
          },
        );
        t.after(async () => {
          if (
            unrelatedWorker.pid &&
            unrelatedWorker.exitCode === null &&
            unrelatedWorker.signalCode === null
          ) {
            const ended = once(unrelatedWorker, "exit");
            unrelatedWorker.kill();
            await ended;
          }
        });
        await once(unrelatedWorker, "spawn");
      }
      assert.equal((await fetch(`${base}/ai/settings`)).status, 401);
      assert.equal((await req("/ai/generate", { messages: [] })).status, 404);
      let view = (await req("/ai/settings")).data;
      assert.equal(
        view.credentialBackend,
        encrypted ? "encrypted_file" : "session_only",
      );
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
      for (const [status, providerCode, expected] of [
        [401, null, "AUTH_REJECTED"],
        [403, null, "ACCESS_REJECTED"],
        [404, null, "MODEL_LIST_NOT_FOUND"],
        [405, null, "MODEL_LIST_UNSUPPORTED"],
        [429, "insufficient_quota", "QUOTA_EXCEEDED"],
        [503, null, "PROVIDER_SERVER_FAILED"],
      ]) {
        listStatus = status;
        listCode = providerCode;
        const listed = await req("/ai/models/discover", { providerId: id });
        assert.equal(listed.status, 422); // Core response status, distinct from upstream.
        assert.equal(listed.data.code, expected);
        assert.doesNotMatch(
          JSON.stringify(listed.data),
          /SECRET_LISTING_CANARY|private provider body/,
        );
      }
      assert.equal(lists, 6);
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
      if (!encrypted) assert.equal(lost.data.code, "CREDENTIAL_UNAVAILABLE");
      else assert.equal(lost.status, 200);
      const uncertain = await req("/ai/connection-tests", action);
      assert.equal(uncertain.data.code, "TEST_STATUS_UNKNOWN");
      assert.equal(calls, 2);
      if (encrypted) {
        view = (await req("/ai/settings")).data;
        assert.equal(view.presentCredentialRevisions.length, 1);
        const runTest = async () => {
          const prepared = (await req("/ai/connection-tests/prepare", target))
            .data;
          const tested = await req("/ai/connection-tests", {
            sessionId: view.sessionId,
            actionId: randomUUID(),
            fingerprint: prepared.configuration.fingerprint,
            target,
          });
          assert.equal(tested.data.status, "succeeded");
        };
        await runTest();
        const previousRevision = view.settings.providers[0].credentialRevision;
        expectedKey = "SYNTHETIC_HTTP_ROTATED_KEY_CANARY";
        view = (
          await req("/ai/credentials", {
            expectedRevision: view.settings.revision,
            providerId: id,
            secret: expectedKey,
          })
        ).data;
        assert.notEqual(
          view.settings.providers[0].credentialRevision,
          previousRevision,
        );
        await runTest();
        assert.equal(calls, 4);
        view = (
          await req("/ai/credentials/delete", {
            expectedRevision: view.settings.revision,
            providerId: id,
            secret: "",
          })
        ).data;
        assert.equal(view.presentCredentialRevisions.length, 0);
        assert.deepEqual(
          JSON.parse(
            await readFile(
              join(appData, "owned-credential-revisions.json"),
              "utf8",
            ),
          ),
          [],
        );
        assert.deepEqual(
          (await readdir(join(appData, "credentials-v1"))).sort(),
          [".lock", "header.json"],
        );
        const before = await readFile(join(appData, "ai-settings.json"));
        for (const locator of [undefined, join(directory, "wrong-key")]) {
          if (locator)
            await writeFile(locator, randomBytes(32).toString("base64"), {
              mode: 0o444,
            });
          await stop();
          keyLocator = locator;
          await boot();
          const unavailable = await req("/ai/settings");
          assert.equal(unavailable.status, 422);
          assert.equal(unavailable.data.code, "CREDENTIAL_UNAVAILABLE");
          assert.deepEqual(
            await readFile(join(appData, "ai-settings.json")),
            before,
          );
        }
        await stop();
        keyLocator = masterKeyFile;
        await boot();
        assert.equal((await req("/ai/settings")).status, 200);
        assert.equal(calls, 4);
      }
      if (unrelatedWorker) {
        assert.equal(unrelatedWorker.exitCode, null);
        assert.equal(unrelatedWorker.signalCode, null);
      }
      if (process.platform === "linux")
        assert.equal(inspectedWorkers, encrypted ? 4 : 2);
      assert.equal(logs.includes("SYNTHETIC_HTTP_KEY_CANARY"), false);
      assert.equal(logs.includes("ENVIRONMENT_CANARY"), false);
      assert.equal(logs.includes("SYNTHETIC_HTTP_ROTATED_KEY_CANARY"), false);
      assert.equal(logs.includes(masterEncoded), false);
      assert.equal(logs.includes(masterKeyFile), false);
      const settings = await readFile(
        join(appData, "ai-settings.json"),
        "utf8",
      );
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
}
