// Release-only smoke: no hosted inference, publication, or persistent deployment volumes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";

const [webImage, runnerImage] = process.argv.slice(2);
if (!webImage || !runnerImage) throw Error("Supply both tested local images");
const root = await mkdtemp("/tmp/scenesparrow-pair-");
const project = `scenesparrow-pair-${process.pid}`;
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const address = `http://127.0.0.1:${port}`;
const origin = "https://scene.example";
const auth = `operator:${randomBytes(24).toString("hex")}`;
const compose = (...args) => {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      `${root}/runtime.env`,
      "-f",
      `${root}/compose.yaml`,
      "-p",
      project,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw Error(`Paired Compose ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
try {
  const definition = (await readFile("deploy/compose.yaml", "utf8"))
    .replace("name: scenesparrow-project", `name: ${project}-project`)
    .replace("name: scenesparrow-appdata", `name: ${project}-appdata`)
    .replace(
      "name: scenesparrow-writing-agent",
      `name: ${project}-writing-agent`,
    );
  await writeFile(`${root}/compose.yaml`, definition);
  await writeFile(`${root}/operator`, auth, { mode: 0o444 });
  await writeFile(`${root}/master`, randomBytes(32).toString("base64"), {
    mode: 0o444,
  });
  await writeFile(
    `${root}/runtime.env`,
    `SCENESPARROW_IMAGE=${webImage}\nSCENESPARROW_DSH_IMAGE=${runnerImage}\nPUBLIC_ORIGIN=${origin}\nWEB_PORT=${port}\nOPERATOR_AUTH_FILE=${root}/operator\nAI_MASTER_KEY_FILE=${root}/master\n`,
    { mode: 0o600 },
  );
  compose("up", "-d", "--pull", "never", "--wait", "--wait-timeout", "120");
  const call = (path, body, method = body ? "POST" : "GET") =>
    new Promise((resolve, reject) => {
      const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            host: "scene.example",
            authorization: `Basic ${Buffer.from(auth).toString("base64")}`,
            origin,
            "content-type": "application/json",
            ...(bytes ? { "content-length": bytes.length } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (c) => chunks.push(c));
          response.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks));
              const code = /^[A-Z_]+$/.test(data?.code ?? "")
                ? ` (${data.code})`
                : "";
              assert.equal(
                response.statusCode,
                200,
                `Smoke endpoint failed: ${path}${code}`,
              );
              resolve(data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(15000, () =>
        req.destroy(Error("Paired smoke request timeout")),
      );
      req.on("error", reject);
      req.end(bytes);
    });
  async function waitForAgent(status) {
    let entry;
    for (let i = 0; i < 20; i++) {
      entry = (await call("/api/v1/agent/catalog")).find(
        (e) => e.id === "deepseek",
      );
      if (entry?.status === status) return entry;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(entry?.status, status);
  }
  const missingKey = await waitForAgent("not_authenticated");
  assert(missingKey.models.length > 0);
  let view = await call("/api/v1/ai/settings");
  const providerId = randomUUID();
  view.settings.providers.push({
    id: providerId,
    label: "DeepSeek",
    adapter: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authMode: "bearer",
    credentialRevision: null,
    revision: 1,
    servicePreset: "deepseek",
  });
  view = await call(
    "/api/v1/ai/settings",
    { expectedRevision: view.settings.revision, settings: view.settings },
    "PUT",
  );
  await call("/api/v1/ai/credentials", {
    expectedRevision: view.settings.revision,
    providerId,
    secret: "SYNTHETIC_CATALOG_ONLY_NO_INFERENCE",
  });
  const connected = await waitForAgent("ready");
  assert.equal(
    connected.available,
    true,
    "saving a key enables native catalog without inference",
  );
  const created = await call("/api/v1/markdown-projects", {
    text: "Initial writing",
  });
  compose("stop", "deepseek");
  assert.equal(
    (await call("/api/v1/agent/catalog")).find((e) => e.id === "deepseek")
      .available,
    false,
  );
  const saved = await call(`/api/v1/markdown-projects/${created.projectId}`, {
    revision: created.revision,
    text: "Saved with runner stopped",
  });
  assert.equal(saved.text, "Saved with runner stopped");
  assert.equal((await fetch(`${address}/readyz`)).status, 200);
  compose("start", "deepseek");
  assert.equal((await waitForAgent("ready")).available, true);
  compose("restart", "web");
  // Web readiness and the relay recover together; stale sockets must not require manual cleanup.
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${address}/readyz`)).ok) break;
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    (await waitForAgent("ready")).available,
    true,
    "encrypted key survives Web restart",
  );
  assert.equal(
    (await call(`/api/v1/markdown-projects/${created.projectId}`)).text,
    saved.text,
  );
  console.log(
    "Paired release smoke passed: missing key, independent saving, runner/Web restart, disposable volumes.",
  );
} finally {
  try {
    compose("down", "--volumes", "--remove-orphans");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
