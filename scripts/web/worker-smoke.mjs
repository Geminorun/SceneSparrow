// Executed through stdin inside the final image, with a synthetic operator credential.
// Review dispatch reaches the actual Rust-supervised agent worker and actual SDK.
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
  assert.equal(JSON.parse(body).model, "smoke-model");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            content: JSON.stringify({
              schemaVersion: 1,
              answer: "Packaged Rust agent SDK answer",
              evidenceReferences: [],
            }),
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
            tokenField: "max_tokens",
          },
        ],
        bindings: [
          {
            category: "text",
            providerId,
            modelId: "smoke-model",
            parameters: {
              temperatureMilli: null,
              maxOutputTokens: 2048,
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
  const project = (await api("/project")).project;
  const command = async (type, payload) => {
    const state = await api("/manuscript");
    return api("/manuscript/commands", {
      type,
      requestId: randomUUID(),
      projectId: project.id,
      expectedWorkingRevision: state.workingRevision,
      payload,
    });
  };
  const block = (await api("/manuscript")).blocks[0];
  const quote = block.runs.map((run) => run.text).join("");
  const id = randomUUID();
  await command("SaveReview", {
    expectedRequestVersion: 0,
    thread: {
      id,
      kind: "question",
      requestVersion: 0,
      text: "Explain this source",
      anchor: {
        ranges: [
          {
            blockId: block.id,
            revision: block.revision,
            start: 0,
            end: quote.length,
            quote,
            wholeBlock: true,
          },
        ],
        state: "mapped",
        slot: null,
      },
      handled: false,
      deleted: false,
      language: "en",
      evidence: [],
      decision: null,
      userMessageIds: [],
    },
  });
  assert.equal(calls, 0);
  await command("StartReviewTask", { threadId: id, requestVersion: 1 });
  let card;
  for (let n = 0; n < 300; n++) {
    card = (await api("/reviews")).cards.find(
      (value) => value.thread.id === id,
    );
    if (card.task && card.task.application !== "pending") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(
    card.task.answer,
    "Packaged Rust agent SDK answer",
    JSON.stringify(card),
  );
  assert.equal(calls, 1);
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
