import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  generate,
  discoverModels,
  FakeTransport,
  sha256,
  transport,
  normalizeError,
} from "../../packages/ai-runtime/src/index.ts";
export function fixture(root = "http://127.0.0.1:1/custom") {
  const evidence = {
    state: "unknown",
    source: "unknown",
    scope: "",
    observedAt: null,
  };
  const providerId = randomUUID();
  const configuration = {
    category: "text",
    capability: "text.generate",
    provider: {
      id: providerId,
      label: "Local",
      adapter: "openai_compatible",
      baseUrl: root,
      authMode: "none",
      credentialRevision: null,
      revision: 1,
    },
    model: {
      providerId,
      id: "manual-model",
      label: "Manual",
      capabilities: {
        images: { ...evidence },
        streaming: { ...evidence },
        nativeJson: { ...evidence },
      },
      contextTokens: null,
      outputTokens: null,
      tokenField: "max_tokens",
    },
    parameters: {
      temperatureMilli: null,
      maxOutputTokens: 64,
      requestStreaming: false,
      requestNativeJson: false,
    },
    policy: { overallMs: 2000, idleMs: 1000, maxOutputBytes: 8388608 },
    adapterVersion: "openai-compatible/1",
    fingerprint: "a".repeat(64),
    stream: false,
    nativeJson: false,
  };
  const input = {
    protocolVersion: 1,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "private fixture text" }],
      },
    ],
    inputArtifacts: [],
    outputSpec: {
      mime: "text/plain",
      schemaId: "opaque/1",
      schemaVersion: 1,
      schemaArtifactId: null,
      maxBytes: 8388608,
    },
    imageDecision: "none",
  };
  return {
    input,
    configuration,
    credential: null,
    signal: new AbortController().signal,
    artifacts: async () => {
      throw Error("unscoped");
    },
  };
}
async function endpoint(fn) {
  let calls = 0;
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    calls++;
    bodies.push({
      path: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    });
    await fn(req, res, bodies.at(-1));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    root: `http://127.0.0.1:${server.address().port}/custom`,
    get calls() {
      return calls;
    },
    bodies,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
const completion = (text, finish = "stop", extra = {}) => ({
  id: "safe",
  choices: [
    {
      index: 0,
      finish_reason: finish,
      message: { role: "assistant", content: text, ...extra },
    },
  ],
});
const json = (res, value) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
};
async function fails(request, code) {
  await assert.rejects(generate(request), (e) => e.code === code);
}

test("independent fake consumer uses opaque schema, same output guards and no business imports", async () => {
  const request = fixture();
  const schema = Buffer.from(
    JSON.stringify({
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    }),
  );
  const id = randomUUID();
  request.input.inputArtifacts = [
    { id, hash: sha256(schema), size: schema.length, mime: "application/json" },
  ];
  request.artifacts = async (got) => {
    assert.equal(got, id);
    return schema;
  };
  request.input.outputSpec = {
    ...request.input.outputSpec,
    mime: "application/json",
    schemaArtifactId: id,
  };
  const fake = new FakeTransport('{"answer":7}');
  assert.equal(
    new TextDecoder().decode((await fake.generate(request)).bytes),
    '{"answer":7}',
  );
  assert.equal(fake.calls, 1);
  for (const output of ["", "\u0000", "\ud800", '{"answer":"wrong"}'])
    await assert.rejects(
      new FakeTransport(output).generate(request),
      (e) => e.code === "INVALID_OUTPUT",
    );
  const aborted = fixture();
  const c = new AbortController();
  c.abort("CANCELLED");
  aborted.signal = c.signal;
  const untouched = new FakeTransport("ok");
  await assert.rejects(
    untouched.generate(aborted),
    (e) => e.code === "CANCELLED",
  );
  assert.equal(untouched.calls, 0);
  for (const p of [
    "packages/ai-runtime/src/index.ts",
    "workers/agent/src/index.ts",
    "workers/agent/src/entry.mjs",
  ]) {
    const source = await readFile(p, "utf8");
    assert.doesNotMatch(
      source,
      /allowedObjectIds|(?:from|import).*?(?:editor-ui|video-runtime|manuscript|remotion)/i,
    );
  }
});

test("official SDK uses manual root and one nonstream call without optional guessed parameters or auth", async () => {
  const ep = await endpoint((req, res) =>
    json(res, completion("hello 世界😀")),
  );
  try {
    const request = fixture(ep.root);
    const output = await generate(request);
    assert.equal(Buffer.from(output.bytes).toString(), "hello 世界😀");
    assert.equal(output.usage, null);
    assert.equal(ep.calls, 1);
    assert.equal(ep.bodies[0].path, "/custom/chat/completions");
    assert.equal(ep.bodies[0].headers.authorization, undefined);
    assert.equal(ep.bodies[0].body.temperature, undefined);
    assert.equal(ep.bodies[0].body.max_tokens, 64);
    assert.equal(ep.bodies[0].body.stream, false);
  } finally {
    await ep.close();
  }
});

test("stream mode and native schema are chosen before one dispatch; Unicode preview never bisects scalars", async () => {
  const text = "a".repeat(4095) + "😀汉字";
  const ep = await endpoint((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const r = fixture(ep.root);
    r.configuration.stream = true;
    r.configuration.model.capabilities.streaming.state = "supported";
    const chunks = [];
    r.emit = (e) => {
      if (e.type === "output_delta") {
        assert.doesNotMatch(
          e.text,
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
        );
        chunks.push(e.text);
      }
    };
    assert.equal(Buffer.from((await generate(r)).bytes).toString(), text);
    assert.equal(chunks.join(""), text);
    assert.equal(ep.calls, 1);
    assert.equal(ep.bodies[0].body.stream, true);
  } finally {
    await ep.close();
  }
  const schema = Buffer.from(
    JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    }),
  );
  const id = randomUUID();
  const native = await endpoint((_q, res) =>
    json(res, completion('{"ok":true}')),
  );
  try {
    const r = fixture(native.root);
    r.configuration.nativeJson = true;
    r.configuration.model.capabilities.nativeJson.state = "supported";
    r.configuration.model.tokenField = "max_completion_tokens";
    r.input.inputArtifacts = [
      {
        id,
        hash: sha256(schema),
        size: schema.length,
        mime: "application/json",
      },
    ];
    r.artifacts = async () => schema;
    r.input.outputSpec.mime = "application/json";
    r.input.outputSpec.schemaArtifactId = id;
    await generate(r);
    assert.equal(native.calls, 1);
    assert.equal(native.bodies[0].body.response_format.type, "json_schema");
    assert.equal(native.bodies[0].body.max_tokens, undefined);
    assert.equal(native.bodies[0].body.max_completion_tokens, 64);
  } finally {
    await native.close();
  }
});

test("split surrogate pair uses four-byte budget while malformed provider scalar/content fails once", async () => {
  const ep = await endpoint((_q, res) => {
    res.setHeader("content-type", "text/event-stream");
    for (const text of ["\ud83d", "\ude00"])
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
      );
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    const r = fixture(ep.root);
    r.configuration.stream = true;
    r.configuration.model.capabilities.streaming.state = "supported";
    r.input.outputSpec.maxBytes = 4;
    assert.equal(Buffer.from((await generate(r)).bytes).toString(), "😀");
    assert.equal(ep.calls, 1);
  } finally {
    await ep.close();
  }
  for (const content of ["\ud800", 123, {}]) {
    const ep = await endpoint((_q, res) => json(res, completion(content)));
    try {
      await fails(fixture(ep.root), "INVALID_OUTPUT");
      assert.equal(ep.calls, 1);
    } finally {
      await ep.close();
    }
  }
});

test("auth/rate/parameter/model/server failures count one request with safe errors and no repair", async () => {
  for (const [status, code] of [
    [401, "AUTH_REJECTED"],
    [429, "RATE_LIMITED"],
    [400, "PROVIDER_REJECTED"],
    [404, "MODEL_UNAVAILABLE"],
    [500, "NETWORK_FAILED"],
  ]) {
    const ep = await endpoint((_q, res) => {
      res.statusCode = status;
      json(res, {
        error: { message: "private prompt and SECRET_CANARY", type: "bad" },
      });
    });
    try {
      await fails(fixture(ep.root), code);
      assert.equal(ep.calls, 1);
    } finally {
      await ep.close();
    }
  }
  for (const [body, code] of [
    [completion("partial", "length"), "OUTPUT_TRUNCATED"],
    [completion("", "stop", { refusal: "private reason" }), "PROVIDER_REFUSED"],
    [
      completion("ok", "tool_calls", {
        tool_calls: [
          {
            id: "x",
            type: "function",
            function: { name: "danger", arguments: "{}" },
          },
        ],
      }),
      "INVALID_OUTPUT",
    ],
  ]) {
    const ep = await endpoint((_q, res) => json(res, body));
    try {
      await fails(fixture(ep.root), code);
      assert.equal(ep.calls, 1);
    } finally {
      await ep.close();
    }
  }
});

test("redirect never forwards bearer and timeout never retries including SDK-only timeout subtype", async () => {
  const target = await endpoint((_q, res) =>
    json(res, completion("must not arrive")),
  );
  const ep = await endpoint((_q, res) => {
    res.writeHead(307, { location: `${target.root}/chat/completions` });
    res.end();
  });
  try {
    const r = fixture(ep.root);
    r.configuration.provider.authMode = "bearer";
    r.credential = "SYNTHETIC_REDIRECT_CANARY";
    await fails(r, "ENDPOINT_REDIRECT");
    assert.equal(ep.calls, 1);
    assert.equal(target.calls, 0);
  } finally {
    await ep.close();
    await target.close();
  }
  const slow = await endpoint(() => {});
  try {
    const r = fixture(slow.root);
    r.configuration.policy.overallMs = 100;
    await fails(r, "REQUEST_TIMEOUT");
    assert.equal(slow.calls, 1);
    const client = transport(r.configuration, null, r.signal, 50);
    await assert.rejects(
      client.chat.completions.create({
        model: "manual",
        messages: [],
        max_tokens: 64,
      }),
      (e) => normalizeError(e).code === "REQUEST_TIMEOUT",
    );
    assert.equal(slow.calls, 2);
  } finally {
    await slow.close();
  }
});

test("manual model survives listing error; discovery is distinct and body deadline covers dribbling", async () => {
  const ep = await endpoint((q, res) => {
    if (q.url.endsWith("/models")) {
      res.statusCode = 405;
      json(res, { error: { message: "no list" } });
    } else json(res, completion("ok"));
  });
  try {
    const r = fixture(ep.root);
    await assert.rejects(discoverModels(r.configuration, null, r.signal));
    await generate(r);
    assert.equal(ep.calls, 2);
    assert.equal(ep.bodies[1].body.model, "manual-model");
  } finally {
    await ep.close();
  }
  const dribble = await endpoint((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":[');
    const timer = setInterval(() => res.write(" "), 40);
    res.on("close", () => clearInterval(timer));
  });
  try {
    const r = fixture(dribble.root);
    const begin = Date.now();
    await assert.rejects(
      discoverModels(r.configuration, null, r.signal),
      (e) => e.code === "REQUEST_TIMEOUT",
    );
    assert.ok(Date.now() - begin < 18000);
    assert.equal(dribble.calls, 1);
  } finally {
    await dribble.close();
  }
});

test("image/capability/context limits and unsafe/recursive schemas reject before inference", async () => {
  const ep = await endpoint((_q, res) => json(res, completion("ok")));
  try {
    const r = fixture(ep.root);
    const bytes = Buffer.from([1, 2, 3]);
    const id = randomUUID();
    r.input.inputArtifacts = [
      { id, mime: "image/png", hash: sha256(bytes), size: 3 },
    ];
    r.input.messages[0].content.push({ type: "image", artifactId: id });
    r.artifacts = async () => bytes;
    await fails(r, "CAPABILITY_UNSUPPORTED");
    assert.equal(ep.calls, 0);
    r.input.imageDecision = "attempt";
    await generate(r);
    assert.equal(ep.calls, 1);
    assert.ok(
      ep.bodies[0].body.messages[0].content[1].image_url.url.startsWith(
        "data:image/png;base64,",
      ),
    );
    for (const schema of [
      { type: "string", pattern: "^(a+)+$" },
      { $ref: "https://evil.test/schema" },
      {
        $ref: "#/definitions/x",
        definitions: { x: { $ref: "#/definitions/x" } },
      },
    ]) {
      const x = fixture(ep.root),
        data = Buffer.from(JSON.stringify(schema)),
        sid = randomUUID();
      x.input.outputSpec.mime = "application/json";
      x.input.outputSpec.schemaArtifactId = sid;
      x.input.inputArtifacts = [
        {
          id: sid,
          mime: "application/json",
          hash: sha256(data),
          size: data.length,
        },
      ];
      x.artifacts = async () => data;
      const start = Date.now();
      await fails(x, "INVALID_OUTPUT_SCHEMA");
      assert.ok(Date.now() - start < 500);
    }
    assert.equal(ep.calls, 1);
    const unsupported = fixture(ep.root);
    unsupported.configuration.category = "audio";
    unsupported.configuration.capability = "audio.synthesize";
    await fails(unsupported, "CAPABILITY_UNSUPPORTED");
    assert.equal(ep.calls, 1);
  } finally {
    await ep.close();
  }
});

function frame(value) {
  const data = Buffer.from(JSON.stringify(value)),
    length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
async function worker(request, extraEnv = {}) {
  const child = spawn(process.execPath, ["workers/agent/src/entry.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      NODE_USE_ENV_PROXY: "1",
      NODE_USE_SYSTEM_CA: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = Buffer.alloc(0),
    stdout = Buffer.alloc(0),
    stderr = "",
    events = [];
  const id = randomUUID(),
    fence = randomUUID();
  const input = Buffer.from(JSON.stringify(request.input));
  child.stderr.on("data", (b) => (stderr += b));
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  const write = (value) => child.stdin.write(frame(value));
  child.stdout.on("data", (b) => {
    stdout = Buffer.concat([stdout, b]);
    pending = Buffer.concat([pending, b]);
    while (pending.length >= 4) {
      const n = pending.readUInt32BE();
      if (n > 4194304) {
        child.kill();
        return;
      }
      if (pending.length < 4 + n) break;
      const event = JSON.parse(pending.subarray(4, 4 + n));
      pending = pending.subarray(4 + n);
      events.push(event);
      if (event.type === "progress" && event.phase === "dispatch_ready")
        write({ type: "dispatch_permit", runId: id, fence });
    }
  });
  write({
    type: "start",
    protocolVersion: 1,
    runId: id,
    attempt: 1,
    fence,
    inputHash: sha256(input),
    configuration: request.configuration,
    operation: "generate",
  });
  const sendArtifact = (artifact, data) => {
    for (let at = 0; at < data.length; at += 24576)
      write({
        type: "artifact_chunk",
        id: artifact.id,
        data: data.subarray(at, at + 24576).toString("base64"),
      });
    write({ type: "artifact_end", artifact });
  };
  sendArtifact(
    { id, hash: sha256(input), mime: "application/json", size: input.length },
    input,
  );
  for (const a of request.input.inputArtifacts)
    sendArtifact(a, Buffer.from(await request.artifacts(a.id)));
  write({
    type: "credential_lease",
    runId: id,
    fence,
    secret: request.credential,
  });
  const timer = setTimeout(() => child.kill(), 5000);
  await ended;
  clearTimeout(timer);
  return { events, stderr, stdout };
}

test("actual framed worker handles nonstream/stream Unicode and suppresses SDK debug/error bodies", async () => {
  for (const stream of [false, true]) {
    const text = "a".repeat(4095) + "😀汉字";
    const ep = await endpoint((_q, res) => {
      if (!stream) return json(res, completion(text));
      res.setHeader("content-type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    try {
      const r = fixture(ep.root);
      r.configuration.stream = stream;
      r.configuration.model.capabilities.streaming.state = "supported";
      const result = await worker(r, { OPENAI_LOG: "debug" });
      assert.equal(result.events.at(-1).type, "completed");
      assert.equal(
        result.events
          .filter((e) => e.type === "output_delta")
          .map((e) => e.text)
          .join(""),
        text,
      );
      assert.equal(result.stderr, "");
      assert.equal(ep.calls, 1);
    } finally {
      await ep.close();
    }
  }
  const ep = await endpoint((_q, res) => {
    res.statusCode = 500;
    json(res, { error: { message: "SECRET_LOG_CANARY private fixture text" } });
  });
  try {
    const r = fixture(ep.root);
    r.configuration.provider.authMode = "bearer";
    r.credential = "SYNTHETIC_KEY_CANARY";
    const result = await worker(r, {
      OPENAI_LOG: "debug",
      OPENAI_API_KEY: "ENV_SECRET_CANARY",
    });
    assert.equal(result.events.at(-1).code, "NETWORK_FAILED");
    assert.equal(result.stderr, "");
    assert.doesNotMatch(
      result.stdout.toString(),
      /SECRET_LOG_CANARY|private fixture text|SYNTHETIC_KEY_CANARY|ENV_SECRET_CANARY/,
    );
    assert.equal(ep.calls, 1);
  } finally {
    await ep.close();
  }
});

test("worker rejects oversized framing before any provider request", async () => {
  const child = spawn(process.execPath, ["workers/agent/src/entry.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (b) => chunks.push(b));
  const done = new Promise((r) => child.on("exit", r));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(4194305);
  child.stdin.end(length);
  await done;
  const out = Buffer.concat(chunks);
  assert.equal(JSON.parse(out.subarray(4)).code, "PROTOCOL_MISMATCH");
});

test("a provider cannot echo the credential into output artifacts or streamed preview", async () => {
  const secret = "SYNTHETIC_SUCCESS_KEY_CANARY";
  for (const stream of [false, true]) {
    const ep = await endpoint((_q, res) => {
      if (!stream) return json(res, completion(secret));
      res.setHeader("content-type", "text/event-stream");
      for (const part of [secret.slice(0, 12), secret.slice(12)])
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: part }, finish_reason: null }] })}\n\n`,
        );
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    try {
      const r = fixture(ep.root);
      r.credential = secret;
      r.configuration.provider.authMode = "bearer";
      r.configuration.stream = stream;
      r.configuration.model.capabilities.streaming.state = "supported";
      const events = [];
      r.emit = (e) => events.push(e);
      await fails(r, "INVALID_OUTPUT");
      assert.ok(
        !events
          .filter((e) => e.type === "output_delta")
          .map((e) => e.text)
          .join("")
          .includes(secret),
      );
      assert.equal(ep.calls, 1);
    } finally {
      await ep.close();
    }
  }
});

test("adapter instructions/schema and message overhead fit budgets before any provider call", async () => {
  const ep = await endpoint((_q, res) => json(res, completion('{"ok":true}')));
  try {
    const schema = Buffer.from(
      JSON.stringify({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      }),
    );
    const make = () => {
      const r = fixture(ep.root),
        id = randomUUID();
      r.input.outputSpec.mime = "application/json";
      r.input.outputSpec.schemaArtifactId = id;
      r.input.inputArtifacts = [
        {
          id,
          hash: sha256(schema),
          size: schema.length,
          mime: "application/json",
        },
      ];
      r.artifacts = async () => schema;
      return r;
    };
    const tooMany = make();
    tooMany.input.messages = Array.from({ length: 128 }, () => ({
      role: "user",
      content: [{ type: "text", text: "x" }],
    }));
    await fails(tooMany, "INPUT_TOO_LARGE");
    for (const native of [false, true]) {
      const r = make();
      r.configuration.nativeJson = native;
      r.configuration.model.capabilities.nativeJson.state = "supported";
      r.input.messages[0].content[0].text = "x".repeat(
        1048576 - schema.length + 1,
      );
      await fails(r, "INPUT_TOO_LARGE");
      const context = make();
      context.configuration.nativeJson = native;
      context.configuration.model.capabilities.nativeJson.state = "supported";
      context.configuration.model.contextTokens = 80;
      await fails(context, "CONTEXT_LIMIT");
    }
    assert.equal(ep.calls, 0);
    const valid = make();
    await generate(valid);
    assert.equal(ep.calls, 1);
  } finally {
    await ep.close();
  }
});
