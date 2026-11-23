// Executed through stdin inside the final image, with a synthetic operator credential.
// File writing reaches the actual Rust-supervised agent worker and SDK.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const publicOrigin = new URL(process.env.PUBLIC_ORIGIN);
const syntheticApiKey = "SYNTHETIC_CONTAINER_API_KEY_CANARY";
let calls = 0;
const server = createServer(async (req, res) => {
  calls++;
  assert.equal(req.url, "/v1/chat/completions");
  assert.equal(req.headers.authorization, `Bearer ${syntheticApiKey}`);
  let body = "";
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  assert.equal(payload.model, "smoke-model");
  assert.equal(payload.max_tokens, undefined);
  assert.equal(payload.max_completion_tokens, undefined);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content:
              calls === 1
                ? "# Outline\n\n- Opening"
                : "# Draft\n\nPackaged Rust agent SDK text",
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
const api = (path, body, method = body ? "POST" : "GET") =>
  new Promise((resolve, reject) => {
    const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = request(
      {
        host: "127.0.0.1",
        port: 8080,
        path: `/api/v1${path}`,
        method,
        headers: {
          host: publicOrigin.host,
          authorization: `Basic ${Buffer.from(credential).toString("base64")}`,
          origin: publicOrigin.origin,
          "content-type": "application/json",
          ...(bytes ? { "content-length": bytes.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks));
            assert.equal(res.statusCode, 200, JSON.stringify(data));
            resolve(data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const view = await api("/ai/settings");
  assert.equal(view.credentialBackend, "encrypted_file");
  const evidence = {
    state: "unknown",
    source: "unknown",
    scope: "",
    observedAt: null,
  };
  const providerId = randomUUID();
  const saved = await api(
    "/ai/settings",
    {
      expectedRevision: view.settings.revision,
      settings: {
        ...view.settings,
        providers: [
          {
            id: providerId,
            label: "Local fake",
            adapter: "openai_compatible",
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            authMode: "bearer",
            credentialRevision: null,
            revision: 1,
          },
        ],
        models: [
          {
            providerId,
            id: "smoke-model",
            label: "Smoke",
            capabilities: {
              images: evidence,
              streaming: evidence,
              nativeJson: evidence,
            },
            contextTokens: 32768,
            outputTokens: 8192,
          },
        ],
        bindings: [
          {
            category: "text",
            providerId,
            modelId: "smoke-model",
            parameters: {
              temperatureMilli: null,
              requestStreaming: false,
              requestNativeJson: false,
            },
            revision: 1,
          },
        ],
      },
    },
    "PUT",
  );
  const credentialView = await api("/ai/credentials", {
    expectedRevision: saved.settings.revision,
    providerId,
    secret: syntheticApiKey,
  });
  assert.equal(credentialView.presentCredentialRevisions.length, 1);
  const project = await api("/markdown-projects", { text: "Before writing." });
  const path = `/markdown-projects/${project.projectId}`;
  const readiness = await api("/ai/configuration");
  const common = {
    sessionId: credentialView.sessionId,
    fingerprint: readiness.configuration.fingerprint,
    brief: "Write a story",
    text: project.text,
    revision: project.revision,
  };
  const outline = await api(path + "/writing", {
    ...common,
    actionId: randomUUID(),
    kind: "outline",
    outline: "",
  });
  assert.match(outline.text, /Opening/);
  const draft = await api(path + "/writing", {
    ...common,
    actionId: randomUUID(),
    kind: "draft",
    outline: outline.text,
  });
  assert.match(draft.text, /Packaged Rust agent SDK text/);
  assert.equal(calls, 2);
  assert.deepEqual(await api(path), project);
  const adopted = await api(path, {
    text: draft.text,
    revision: project.revision,
  });
  assert.equal(adopted.text, draft.text);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
