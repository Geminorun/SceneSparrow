import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const image = process.argv[2];
const { version } = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
assert.ok(image, "Supply the locally built image tag");
const run = (args, options = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || "Docker command failed");
  return result.stdout?.trim();
};
const id = `scenesparrow-smoke-${randomUUID()}`;
const temporary = await mkdtemp(join(tmpdir(), id));
const credential = `operator:${randomUUID().replaceAll("-", "").slice(0, 6)}`;
const origin = "https://scene.mindreview.me";
const volumes = [`${id}-project`, `${id}-app`, `${id}-restored`];
const restoredId = `${id}-recovery`;
let port;
const send = (path, body, extra = {}) =>
  new Promise((resolve, reject) => {
    const bytes =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: bytes ? "POST" : "GET",
        headers: {
          host: "scene.mindreview.me",
          authorization: `Basic ${Buffer.from(credential).toString("base64")}`,
          origin,
          "content-type": "application/json",
          ...(bytes ? { "content-length": bytes.length } : {}),
          ...extra,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(Error("Request timed out")));
    req.on("error", reject);
    req.end(bytes);
  });
const api = async (path, body, headers) => {
  const response = await send(`/api/v1${path}`, body, headers);
  assert.equal(response.status, 200, response.bytes.toString());
  return JSON.parse(response.bytes);
};
const wait = async () => {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await send("/readyz")).status === 200) return;
    } catch {
      /* Startup. */
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw Error("Container readiness failed");
};
try {
  const auth = join(temporary, "auth");
  await writeFile(auth, credential, { mode: 0o444 });
  await chmod(auth, 0o444);
  const master = join(temporary, "master");
  const masterEncoded = randomBytes(32).toString("base64");
  await writeFile(master, masterEncoded, { mode: 0o444 });
  await chmod(master, 0o444);
  const launch = async (container, projectVolume) => {
    run([
      "run",
      "-d",
      "--init",
      "--name",
      container,
      "-p",
      "127.0.0.1::8080",
      "--mount",
      `type=bind,src=${auth},dst=/run/secrets/operator_auth,readonly`,
      "--mount",
      `type=bind,src=${master},dst=/run/secrets/ai_master_key,readonly`,
      "--mount",
      `type=volume,src=${projectVolume},dst=/data/project`,
      "--mount",
      `type=volume,src=${volumes[1]},dst=/data/app`,
      "-e",
      `PUBLIC_ORIGIN=${origin}`,
      image,
    ]);
    port = Number(run(["port", container, "8080/tcp"]).split(":").at(-1));
    await wait();
  };
  await launch(id, volumes[0]);
  assert.equal((await send("/", undefined, { authorization: "" })).status, 401);
  assert.match((await send("/")).bytes.toString(), /<html/);
  assert.equal(run(["exec", id, "id", "-u"]), "1000");
  const status = await send("/diagnostics/v1/status");
  assert.equal(status.status, 200);
  const diagnosticsStatus = JSON.parse(status.bytes);
  assert.equal(diagnosticsStatus.appVersion, version);
  assert.equal(diagnosticsStatus.collector, "ready");
  assert.equal(diagnosticsStatus.coreAvailable, true);
  assert.match(
    (await send("/diagnostics")).bytes.toString(),
    /diagnostics:read/,
  );
  const grant = await send("/diagnostics/v1/access-grants", { ttlSeconds: 60 });
  assert.equal(grant.status, 201);
  const access = JSON.parse(grant.bytes);
  const diagnosticHeaders = { authorization: "Bearer " + access.token };
  assert.equal(
    (await send("/diagnostics/v1/status", undefined, diagnosticHeaders)).status,
    200,
  );
  assert.equal(
    (await send("/api/v1/project", undefined, diagnosticHeaders)).status,
    403,
  );
  const bundle = await send(
    "/diagnostics/v1/bundle",
    undefined,
    diagnosticHeaders,
  );
  assert.equal(bundle.status, 200);
  assert.ok(bundle.bytes.length <= 1048576);
  assert.ok(!bundle.bytes.includes(Buffer.from(access.token)));
  assert.ok(!bundle.bytes.includes(Buffer.from(credential)));
  assert.equal(
    (await send("/diagnostics/v1/access-grants/revoke", {})).status,
    200,
  );
  assert.equal(
    (await send("/diagnostics/v1/status", undefined, diagnosticHeaders)).status,
    401,
  );
  assert.equal((await api("/health")).markdownProjects, true);
  assert.equal((await send("/api/v1/project")).status, 404);
  const project = await api("/markdown-projects", {
    text: "# Container persistence 中文\n",
  });
  const projectPath = `/markdown-projects/${project.projectId}`;
  const text =
    "\ufeff# Saved in the production container\r\n\r\n中文 Markdown\r\n";
  const state = await api(projectPath, { text, revision: project.revision });
  assert.equal(state.text, text);
  assert.equal(state.revision, createHash("sha256").update(text).digest("hex"));
  assert.equal(
    (
      await send(`/api/v1${projectPath}`, {
        text: "Outdated",
        revision: project.revision,
      })
    ).status,
    409,
  );
  const archive = await send(
    `/api/v1${projectPath}/exchange?revision=${state.revision}`,
  );
  assert.equal(archive.status, 200);
  assert.deepEqual(
    await api(projectPath + "/exchange", archive.bytes, {
      "content-type": "application/zip",
    }),
    {
      projectId: project.projectId,
      baseRevision: state.revision,
      currentRevision: state.revision,
      text,
    },
  );
  const workerSmoke = await readFile(
    new URL("./worker-smoke.mjs", import.meta.url),
    "utf8",
  );
  run(["exec", "-i", id, "node", "--input-type=module"], {
    input: `const credential = ${JSON.stringify(credential)};\n${workerSmoke}`,
  });
  const aiSettings = await api("/ai/settings");
  assert.equal(aiSettings.credentialBackend, "encrypted_file");
  assert.equal(aiSettings.presentCredentialRevisions.length, 1);
  const inspectVault =
    'const fs=require("node:fs"); const p="/data/app/credentials-v1"; const data=fs.readdirSync(p).filter(n=>n!==".lock").map(n=>fs.readFileSync(p+"/"+n,"utf8")).join(""); if(data.includes("SYNTHETIC_CONTAINER_API_KEY_CANARY")) process.exit(1);';
  run(["exec", id, "node", "-e", inspectVault]);
  run(["restart", "--time", "60", id]);
  port = Number(run(["port", id, "8080/tcp"]).split(":").at(-1));
  await wait();
  assert.deepEqual(await api(projectPath), state);
  const reopenedSettings = await api("/ai/settings");
  assert.deepEqual(reopenedSettings.settings, aiSettings.settings);
  assert.deepEqual(
    reopenedSettings.presentCredentialRevisions,
    aiSettings.presentCredentialRevisions,
  );
  assert.equal(reopenedSettings.credentialBackend, "encrypted_file");
  const finalBundle = await send("/diagnostics/v1/bundle");
  assert.equal(finalBundle.status, 200);
  for (const canary of [masterEncoded, "SYNTHETIC_CONTAINER_API_KEY_CANARY"]) {
    assert.ok(!finalBundle.bytes.includes(Buffer.from(canary)));
    assert.ok(!run(["logs", id]).includes(canary));
  }
  run(["stop", "--time", "60", id]);
  assert.equal(run(["inspect", "--format", "{{.State.ExitCode}}", id]), "0");
  const backupMount = `type=bind,src=${temporary},dst=/backup`;
  run([
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "tar",
    "--mount",
    `type=volume,src=${volumes[0]},dst=/source,readonly`,
    "--mount",
    backupMount,
    image,
    "-czf",
    "/backup/project.tar.gz",
    "-C",
    "/source",
    ".",
  ]);
  run([
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "tar",
    "--mount",
    `type=volume,src=${volumes[2]},dst=/restore`,
    "--mount",
    `${backupMount},readonly`,
    image,
    "-xzf",
    "/backup/project.tar.gz",
    "-C",
    "/restore",
  ]);
  await launch(restoredId, volumes[2]);
  assert.deepEqual(await api(projectPath), state);
  const storedFiles = run([
    "exec",
    restoredId,
    "node",
    "-e",
    `const assert = require("node:assert/strict"); const fs = require("node:fs"); const root = "/data/project/markdown-projects"; assert.deepEqual(fs.readdirSync("/data/project"), ["markdown-projects"]); console.log(JSON.stringify(fs.readdirSync(root + "/" + process.argv[1]).sort()));`,
    project.projectId,
  ]);
  assert.deepEqual(JSON.parse(storedFiles), ["manuscript.md", "project.json"]);
  run(["stop", "--time", "60", restoredId]);
  assert.equal(
    run(["inspect", "--format", "{{.State.ExitCode}}", restoredId]),
    "0",
  );
  console.log(
    "Container smoke passed: authenticated built Web, file writes, AI drafting, encrypted credentials, graceful restart and restored project.",
  );
} catch (error) {
  const logs = spawnSync("docker", ["logs", "--tail", "20", id], {
    encoding: "utf8",
  });
  console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  for (const container of [restoredId, id])
    spawnSync("docker", ["rm", "-f", container]);
  for (const volume of volumes) spawnSync("docker", ["volume", "rm", volume]);
  await rm(temporary, { recursive: true, force: true });
}
