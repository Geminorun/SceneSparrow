import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  access,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { start, waitFor } from "../../scripts/processes.mjs";

const unknown = () => ({
  state: "unknown",
  source: "unknown",
  scope: "",
  observedAt: null,
});
test("WFW-AC03–04: file writing uses the real bearer worker once per session action and writes only on explicit adoption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-writing-"));
  let calls = 0,
    release,
    observed;
  let gate = new Promise((resolve) => {
    release = resolve;
  });
  let arrival = new Promise((resolve) => {
    observed = resolve;
  });
  let output = "# Outline\n\n- 开场";
  let providerStatus = 200;
  const provider = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(
      request.headers.authorization,
      "Bearer SYNTHETIC_FILE_WRITING_KEY",
    );
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "file-writer");
    assert.equal(parsed.max_tokens, undefined);
    assert.equal(parsed.max_completion_tokens, undefined);
    calls++;
    observed(parsed);
    await gate;
    response.writeHead(providerStatus, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        providerStatus === 200
          ? {
              choices: [
                {
                  message: { content: output },
                  finish_reason: "stop",
                  index: 0,
                },
              ],
            }
          : { error: { message: "PRIVATE_PROVIDER_BODY" } },
      ),
    );
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const token = randomBytes(32).toString("hex");
  const base = `http://127.0.0.1:${port}/v1`;
  const root = join(directory, "files"),
    unused = join(directory, "unused-sql");
  let child;
  async function boot() {
    child = start(
      process.env.SCENESPARROW_CORE_BIN ??
        "./target/debug/scenesparrow-service",
      [],
      {
        env: {
          ...process.env,
          SCENESPARROW_SESSION_TOKEN: token,
          SCENESPARROW_CORE_PORT: String(port),
          SCENESPARROW_MARKDOWN_PROJECTS_DIR: root,
          SCENESPARROW_PROJECT_DIR: unused,
          SCENESPARROW_APP_DATA_DIR: join(directory, "app"),
        },
        stdio: "ignore",
      },
    );
    await waitFor(
      `${base}/health`,
      { Authorization: `Bearer ${token}` },
      child,
    );
  }
  async function stop() {
    if (child?.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGINT");
      await ended;
    }
  }
  async function req(path, body, method) {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    await boot();
    const project = (
      await req("/markdown-projects", { text: "Original manuscript" })
    ).data;
    let view = (await req("/ai/settings")).data;
    const settings = view.settings,
      providerId = randomUUID();
    settings.providers = [
      {
        id: providerId,
        label: "Counted local fixture",
        adapter: "openai_compatible",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        authMode: "bearer",
        credentialRevision: null,
        revision: 1,
      },
    ];
    settings.models = [
      {
        providerId,
        id: "file-writer",
        label: "Writer",
        capabilities: {
          images: unknown(),
          streaming: unknown(),
          nativeJson: unknown(),
        },
        contextTokens: null,
        outputTokens: null,
      },
    ];
    settings.bindings = [
      {
        category: "text",
        providerId,
        modelId: "file-writer",
        parameters: {
          temperatureMilli: null,
          requestStreaming: false,
          requestNativeJson: false,
        },
        revision: 1,
      },
    ];
    view = (await req("/ai/settings", { expectedRevision: 0, settings }, "PUT"))
      .data;
    view = (
      await req("/ai/credentials", {
        expectedRevision: view.settings.revision,
        providerId,
        secret: "SYNTHETIC_FILE_WRITING_KEY",
      })
    ).data;
    const ready = (await req("/ai/configuration")).data;
    const action = {
      actionId: randomUUID(),
      sessionId: view.sessionId,
      fingerprint: ready.configuration.fingerprint,
      kind: "outline",
      brief: "Write a bilingual story",
      outline: "",
      text: project.text,
      revision: project.revision,
    };
    const path = `/markdown-projects/${project.projectId}/writing`;
    const first = req(path, action);
    await arrival;
    const duplicate = await req(path, action);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.code, "ACTION_IN_PROGRESS");
    assert.equal(
      (await req(path, { ...action, brief: "Different input" })).data.code,
      "REQUEST_ID_REUSED",
    );
    assert.equal(
      (await req(`/markdown-projects/${project.projectId}`)).data.text,
      project.text,
    );
    release();
    const completed = await first;
    assert.equal(completed.status, 200);
    assert.equal(completed.data.text, output);
    assert.deepEqual(await req(path, action), completed);
    assert.equal(calls, 1);
    output = "# Draft\n\nA complete bilingual manuscript. 中文。";
    arrival = new Promise((resolve) => {
      observed = resolve;
    });
    const outlinePath = `/markdown-projects/${project.projectId}/documents/outline`;
    assert.equal((await req(outlinePath)).data.revision, null);
    const savedOutline = (
      await req(outlinePath, {
        revision: null,
        text: "# User-edited outline\n\n- A different ending",
      })
    ).data;
    const draftAction = {
      ...action,
      actionId: randomUUID(),
      kind: "draft",
      brief: "",
      outline: "Untrusted caller outline",
      outlineRevision: savedOutline.revision,
    };
    assert.equal(
      (
        await req(path, {
          ...draftAction,
          actionId: randomUUID(),
          outlineRevision: "0".repeat(64),
        })
      ).data.code,
      "MARKDOWN_CONFLICT",
    );
    assert.equal(calls, 1);
    const drafted = req(path, draftAction);
    const dispatched = await arrival;
    assert.match(JSON.stringify(dispatched.messages), /User-edited outline/);
    assert.doesNotMatch(
      JSON.stringify(dispatched.messages),
      /Untrusted caller/,
    );
    const draft = (await drafted).data.text;
    const manuscript = join(root, project.projectId, "manuscript.md");
    assert.equal(await readFile(manuscript, "utf8"), project.text);
    assert.equal(
      (
        await req(`/markdown-projects/${project.projectId}`, {
          text: draft,
          revision: project.revision,
        })
      ).status,
      200,
    );
    assert.equal(await readFile(manuscript, "utf8"), output);
    assert.deepEqual((await readdir(join(root, project.projectId))).sort(), [
      "manuscript.md",
      "outline.md",
      "project.json",
    ]);
    const current = (await req(`/markdown-projects/${project.projectId}`)).data;
    await req(outlinePath, {
      revision: savedOutline.revision,
      text: "Changed elsewhere",
    });
    assert.equal(
      (
        await req(`/markdown-projects/${project.projectId}`, {
          revision: current.revision,
          text: "Stale adoption",
          outlineRevision: savedOutline.revision,
        })
      ).data.code,
      "MARKDOWN_CONFLICT",
    );
    assert.equal(await readFile(manuscript, "utf8"), output);
    providerStatus = 500;
    const failedAction = {
      ...action,
      actionId: randomUUID(),
      revision: current.revision,
    };
    const failed = await req(path, failedAction);
    assert.equal(failed.status, 422);
    assert.equal(failed.data.code, "PROVIDER_SERVER_FAILED");
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_BODY/);
    assert.deepEqual(await req(path, failedAction), failed);
    assert.equal(calls, 3);
    await writeFile(manuscript, "External newer input");
    assert.equal(
      (await req(path, { ...failedAction, actionId: randomUUID() })).data.code,
      "MARKDOWN_CONFLICT",
    );
    assert.equal(
      (
        await req(`/markdown-projects/${project.projectId}`, {
          text: draft,
          revision: current.revision,
        })
      ).status,
      409,
    );
    assert.equal(await readFile(manuscript, "utf8"), "External newer input");
    await stop();
    await boot();
    const reopened = (await req(`/markdown-projects/${project.projectId}`))
      .data;
    assert.equal(
      (await req(path, { ...action, revision: reopened.revision })).data.code,
      "ACTION_SESSION_ENDED",
    );
    assert.equal(calls, 3);
    await assert.rejects(access(unused));
  } finally {
    release();
    await stop();
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
