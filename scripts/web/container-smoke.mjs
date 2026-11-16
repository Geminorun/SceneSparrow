import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { docx, pdf } from "../../tests/fixtures/documents.mjs";

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
const volumes = [`${id}-project`, `${id}-app`];
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
  run([
    "run",
    "-d",
    "--init",
    "--name",
    id,
    "-p",
    "127.0.0.1::8080",
    "--mount",
    `type=bind,src=${auth},dst=/run/secrets/operator_auth,readonly`,
    "--mount",
    `type=volume,src=${volumes[0]},dst=/data/project`,
    "--mount",
    `type=volume,src=${volumes[1]},dst=/data/app`,
    "-e",
    `PUBLIC_ORIGIN=${origin}`,
    image,
  ]);
  port = Number(run(["port", id, "8080/tcp"]).split(":").at(-1));
  await wait();
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
  const project = (
    await api("/project", {
      requestId: randomUUID(),
      title: "Container persistence 中文",
    })
  ).project;
  let state = await api("/manuscript");
  const command = async (type, payload) => {
    await api("/manuscript/commands", {
      type,
      requestId: randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: state.workingRevision,
      payload,
    });
    state = await api("/manuscript");
  };
  for (const [name, bytes] of [
    ["input.txt", Buffer.from("Packaged TXT 中文")],
    ["input.md", Buffer.from("# Packaged Markdown\n\nBody")],
    ["input.docx", docx("<w:p><w:r><w:t>Packaged DOCX</w:t></w:r></w:p>")],
    ["input.pdf", pdf()],
  ]) {
    const intake = await api("/intakes", bytes, {
      "content-type": "application/octet-stream",
      "x-intake-id": randomUUID(),
      "x-file-name": encodeURIComponent(name),
    });
    const sourceId = randomUUID();
    await command("AddSourceFile", {
      sourceId,
      intakeId: intake.id,
      hash: intake.hash,
    });
    const jobId = randomUUID();
    await api("/document-jobs", { type: "extractSource", jobId, sourceId });
    let job;
    for (let n = 0; n < 200; n++) {
      job = await api(`/document-jobs/${jobId}`);
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(job.status, "ready", JSON.stringify(job));
    assert.ok(job.result.text.length > 0);
  }
  await command("StartManualDraft", {});
  await command("ApplyDocumentEdit", {
    operations: [
      {
        op: "insertBlock",
        after: null,
        block: {
          id: randomUUID(),
          kind: "paragraph",
          attrs: {},
          runs: [{ text: "Persistent export 中文", marks: [] }],
        },
      },
    ],
    expectedBlockRevisions: [],
    group: {
      clientSessionId: randomUUID(),
      groupId: randomUUID(),
      groupSequence: 1,
      kind: "discrete",
    },
  });
  const bodyHash = createHash("sha256")
    .update(
      `canonical-1|${state.manuscriptId}|${state.schemaVersion}|${state.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`,
    )
    .digest("hex");
  for (const format of ["txt", "md", "docx"]) {
    let job = await api("/manuscript/exports", {
      requestId: randomUUID(),
      expectedRevision: state.workingRevision,
      expectedBodyHash: bodyHash,
      format,
    });
    for (
      let n = 0;
      n < 200 && ["queued", "running"].includes(job.status);
      n++
    ) {
      await new Promise((done) => setTimeout(done, 50));
      job = await api(`/manuscript/exports/${job.id}`);
    }
    assert.equal(job.status, "ready", JSON.stringify(job));
    const artifact = await send(
      `/api/v1/manuscript/exports/${job.id}/artifact`,
    );
    assert.equal(artifact.status, 200);
    assert.equal(
      createHash("sha256").update(artifact.bytes).digest("hex"),
      job.artifactHash,
    );
  }
  const workerSmoke = await readFile(
    new URL("./worker-smoke.mjs", import.meta.url),
    "utf8",
  );
  run(["exec", "-i", id, "node", "--input-type=module"], {
    input: `const credential = ${JSON.stringify(credential)};\n${workerSmoke}`,
  });
  state = await api("/manuscript");
  run(["restart", "--time", "60", id]);
  port = Number(run(["port", id, "8080/tcp"]).split(":").at(-1));
  await wait();
  assert.equal((await api("/project")).project.id, project.id);
  assert.deepEqual(await api("/manuscript"), state);
  run(["stop", "--time", "60", id]);
  assert.equal(run(["inspect", "--format", "{{.State.ExitCode}}", id]), "0");
  console.log(
    "Container smoke passed: real core, authenticated built Web, document workers, exports, AI SDK, graceful restart and persistence.",
  );
} catch (error) {
  const logs = spawnSync("docker", ["logs", "--tail", "20", id], {
    encoding: "utf8",
  });
  console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  run(["rm", "-f", id]);
  for (const volume of volumes) run(["volume", "rm", volume]);
  await rm(temporary, { recursive: true, force: true });
}
