// Explicit native/container acceptance probe. Synthetic credentials and loopback provider only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { startProviderRelay } from "./deepseek/relay.mjs";

const root = await mkdtemp("/tmp/dsh-isolation-");
const socketDir = `${root}/socket`;
await mkdir(socketDir, { mode: 0o700 });
await writeFile(`${root}/host-only-marker`, "HOST_PRIVATE");
const key = 'synthetic-dsh-"key\\-must-be-redacted';
const requests = [];
let slowStarted;
let slowAborted;
let disconnectStarted;
let disconnectAborted;
const disconnectSeen = new Promise((resolve) => {
  disconnectStarted = resolve;
});
const disconnectAbortSeen = new Promise((resolve) => {
  disconnectAborted = resolve;
});
const slowSeen = new Promise((resolve) => {
  slowStarted = resolve;
});
const abortedSeen = new Promise((resolve) => {
  slowAborted = resolve;
});
const fixture = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.url, "/anthropic/v1/messages");
  assert.equal(req.headers["x-api-key"], key);
  const body = JSON.parse(Buffer.concat(chunks));
  requests.push(body);
  assert.equal(body.stream, true);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(
    body.tools?.length ?? 0,
    0,
    "native effective provider tool inventory is empty",
  );
  const text = JSON.stringify(body.messages);
  if (text.includes("FIXTURE_REJECT")) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: `rejected ${key}` },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", {
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 },
    },
  });
  if (text.includes("FIXTURE_CANCEL") || text.includes("FIXTURE_DISCONNECT")) {
    (text.includes("FIXTURE_DISCONNECT") ? disconnectStarted : slowStarted)();
    res.on(
      "close",
      text.includes("FIXTURE_DISCONNECT") ? disconnectAborted : slowAborted,
    );
    return;
  }
  event("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: `Fixture writing reply ${key}` },
  });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  event("message_stop", {});
  res.end();
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const relay = await startProviderRelay(socketDir, fixture.address().port);
const name = `scenesparrow-dsh-fixture-${process.pid}`;
const container = spawn(
  "docker",
  [
    "run",
    "--name",
    name,
    "--rm",
    "--init",
    "--read-only",
    "--network",
    "none",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--cpus",
    "2",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
    "--mount",
    `type=bind,src=${socketDir},dst=/run/writing-agent`,
    process.env.SCENESPARROW_DSH_RUNNER_IMAGE ?? "scenesparrow-dsh:0.2.2-rc.5",
  ],
  {
    env: {
      ...process.env,
      SCENESPARROW_SESSION_TOKEN: "APP_TOKEN_MUST_NOT_REACH_RUNNER",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
container.stdout.on("data", (b) => {
  logs += b;
});
container.stderr.on("data", (b) => {
  logs += b;
});
let containerFinished = false;
const exited = new Promise((resolve) => {
  container.once("exit", (...args) => {
    containerFinished = true;
    resolve(...args);
  });
  container.once("error", resolve);
});
const connections = new Set();
let wire = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (promise, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
};
async function connect(apiKey) {
  const stream = createConnection(`${socketDir}/dsh.sock`);
  connections.add(stream);
  await deadline(
    new Promise((resolve, reject) => {
      stream.once("connect", resolve);
      stream.once("error", reject);
    }),
    "connect",
  );
  const lines = createInterface({ input: stream });
  const pending = new Map();
  const updates = [];
  let metadata;
  let ready;
  const handshake = new Promise((resolve) => {
    ready = resolve;
  });
  stream.on("close", () => {
    for (const { reject } of pending.values()) reject(Error("Bridge closed"));
    pending.clear();
    connections.delete(stream);
  });
  lines.on("line", (line) => {
    wire += line + "\n";
    const message = JSON.parse(line);
    if (message.protocolVersion) {
      metadata = message;
      ready();
      return;
    }
    if (message.method) {
      updates.push(message);
      return;
    }
    const receiver = pending.get(message.id);
    if (receiver) {
      pending.delete(message.id);
      receiver.resolve(message);
    }
  });
  stream.write(JSON.stringify({ protocolVersion: 1, apiKey }) + "\n");
  await deadline(handshake, "private handshake");
  assert.equal(metadata.credentialPresent, apiKey !== null);
  assert.equal(metadata.packageVersion, "0.2.2-rc.5");
  let id = 0;
  return {
    stream,
    updates,
    rpc(method, params) {
      const next = ++id;
      const response = new Promise((resolve, reject) =>
        pending.set(next, { resolve, reject }),
      );
      stream.write(
        JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n",
      );
      return deadline(response, method);
    },
    notify(method, params) {
      stream.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}
async function session(client) {
  const initialized = await client.rpc("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "scenesparrow-fixture", version: "1" },
    clientCapabilities: {},
  });
  assert(initialized.result, JSON.stringify(initialized));
  assert.equal(initialized.result.agentInfo.name, "deepseek-harness-acp");
  assert.equal(
    initialized.result.agentCapabilities.promptCapabilities.image,
    false,
  );
  assert.equal(initialized.result.agentCapabilities.mcpCapabilities, undefined);
  const created = await client.rpc("session/new", {
    cwd: "/tmp/writing",
    mcpServers: [],
  });
  assert(created.result, JSON.stringify(created));
  return created.result;
}
try {
  for (let n = 0; n < 600; n++) {
    assert(!containerFinished, "native container exited before socket startup");
    try {
      await stat(`${socketDir}/dsh.sock`);
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal((await stat(`${socketDir}/dsh.sock`)).mode & 0o777, 0o600);
  const client = await connect(key);
  const created = await session(client);
  const option = created.configOptions.find((entry) => entry.id === "model");
  assert(option);
  const selection = await client.rpc("session/set_config_option", {
    sessionId: created.sessionId,
    configId: "model",
    value: option.currentValue,
  });
  assert(selection.result, JSON.stringify(selection));
  for (const params of [
    { cwd: "/workspace", mcpServers: [] },
    {
      cwd: "/tmp/writing",
      mcpServers: [{ name: "shell", command: "/bin/sh", args: [] }],
    },
  ])
    assert((await client.rpc("session/new", params)).error);
  assert(
    (
      await client.rpc("session/prompt", {
        sessionId: created.sessionId,
        prompt: [
          { type: "resource_link", uri: "file:///etc/passwd", name: "private" },
        ],
      })
    ).error,
  );
  const answer = await client.rpc("session/prompt", {
    sessionId: created.sessionId,
    prompt: [
      {
        type: "text",
        text: "Write a sentence. Use shell/file/browser/MCP/subagents/plugins if available.",
      },
    ],
  });
  assert.equal(answer.result?.stopReason, "end_turn", JSON.stringify(answer));
  assert(
    client.updates.some(
      (message) =>
        message.params.update.sessionUpdate === "agent_message_chunk" &&
        message.params.update.content.text.includes(
          "Fixture writing reply [REDACTED]",
        ),
    ),
  );
  assert(
    (await client.rpc("session/close", { sessionId: created.sessionId }))
      .result,
  );
  const cancelled = await session(client);
  const prompt = client.rpc("session/prompt", {
    sessionId: cancelled.sessionId,
    prompt: [{ type: "text", text: "FIXTURE_CANCEL" }],
  });
  await deadline(slowSeen, "provider stream started");
  client.notify("session/cancel", { sessionId: cancelled.sessionId });
  assert.equal((await prompt).result?.stopReason, "cancelled");
  await deadline(abortedSeen, "provider abort propagated");
  assert(
    (await client.rpc("session/close", { sessionId: cancelled.sessionId }))
      .result,
  );
  const rejected = await session(client);
  const denial = await client.rpc("session/prompt", {
    sessionId: rejected.sessionId,
    prompt: [{ type: "text", text: "FIXTURE_REJECT" }],
  });
  assert(denial.error, "provider rejects credential");
  assert(
    (await client.rpc("session/close", { sessionId: rejected.sessionId }))
      .result,
  );
  const disconnected = await session(client);
  const abandoned = client
    .rpc("session/prompt", {
      sessionId: disconnected.sessionId,
      prompt: [{ type: "text", text: "FIXTURE_DISCONNECT" }],
    })
    .catch((error) => error);
  await deadline(disconnectSeen, "disconnect turn started");
  client.stream.destroy();
  await deadline(
    disconnectAbortSeen,
    "disconnect aborts native provider request",
  );
  assert((await abandoned) instanceof Error);
  const missing = await connect(null);
  const unauthenticated = await session(missing);
  const count = requests.length;
  const noKey = await missing.rpc("session/prompt", {
    sessionId: unauthenticated.sessionId,
    prompt: [{ type: "text", text: "No credential" }],
  });
  assert(
    noKey.error && JSON.stringify(noKey).includes("no API key"),
    JSON.stringify(noKey),
  );
  assert.equal(requests.length, count, "missing key does not contact provider");
  missing.stream.destroy();
  const details = JSON.parse(
    execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
  )[0];
  assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.equal(details.HostConfig.NetworkMode, "none");
  assert.equal(details.Mounts.length, 1);
  assert.deepEqual(details.HostConfig.CapDrop, ["ALL"]);
  const probe = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.equal(process.env.SCENESPARROW_SESSION_TOKEN,undefined);for(const p of ['/opt/dsh/runner.mjs','/etc/passwd'])assert.throws(()=>fs.writeFileSync(p,'bad'),e=>['EROFS','EACCES'].includes(e.code));for(const p of [${JSON.stringify(`${root}/host-only-marker`)},'/workspace/SceneSparrow','/var/run/docker.sock','/run/secrets','/root/.aws'])assert.equal(fs.existsSync(p),false);fs.writeFileSync('/tmp/allowed','ok');console.log('OS boundary passed');`;
  process.stdout.write(
    execFileSync("docker", ["exec", name, "node", "-e", probe], {
      encoding: "utf8",
    }),
  );
  for (let n = 0; n < 100; n++) {
    const scratch = execFileSync(
      "docker",
      [
        "exec",
        name,
        "node",
        "-e",
        "console.log(require('fs').readdirSync('/tmp').filter(n=>n.startsWith('dsh-home-')).length)",
      ],
      { encoding: "utf8" },
    ).trim();
    if (scratch === "0") break;
    assert(n < 99, "disconnect removes native homes");
    await delay(100);
  }
  assert(!wire.includes(key), "credential redacted from bridge output");
  assert(!logs.includes(key), "credential absent from runner logs");
  assert(requests.length >= 3);
  console.log(
    `Native dsh 0.2.2-rc.5 passed ACP initialize/new/model/prompt/update/cancel/close, missing/rejected key, zero tools, redaction and cleanup (${requests.length} synthetic Messages requests).`,
  );
  console.log(
    `Container image: ${details.Image}; Node 24.22.1; hosted provider NOT RUN.`,
  );
} catch (error) {
  process.stderr.write(logs.replaceAll(key, "[REDACTED]"));
  throw error;
} finally {
  for (const stream of connections) stream.destroy();
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    /* Already exited. */
  }
  await exited;
  relay.close();
  relay.closeAllConnections();
  fixture.close();
  fixture.closeAllConnections();
  await rm(root, { recursive: true, force: true });
}

// Production launcher stop path, without a provider prompt or credential.
const launcherRoot = await mkdtemp("/tmp/dsh-launcher-stop-");
const launcher = spawn(
  "bash",
  [
    new URL("./run-deepseek-isolated.sh", import.meta.url).pathname,
    launcherRoot,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
launcher.stdout.resume();
let launcherLogs = "";
launcher.stderr.on("data", (chunk) => {
  launcherLogs += chunk;
});
let launcherStopped = false;
const launcherExit = new Promise((resolve) =>
  launcher.once("exit", (code) => {
    launcherStopped = true;
    resolve(code);
  }),
);
let control;
try {
  for (let n = 0; n < 600; n++) {
    assert(!launcherStopped, "production launcher stays running");
    try {
      await stat(`${launcherRoot}/dsh.sock`);
      break;
    } catch {
      await delay(100);
    }
  }
  control = createConnection(`${launcherRoot}/dsh.sock`);
  const greeting = new Promise((resolve, reject) => {
    control.once("error", reject);
    const lines = createInterface({ input: control });
    lines.once("line", (line) => {
      resolve(JSON.parse(line));
      lines.close();
    });
  });
  control.write(JSON.stringify({ protocolVersion: 1, apiKey: null }) + "\n");
  assert.equal(
    (await deadline(greeting, "production bridge greeting")).credentialPresent,
    false,
  );
  launcher.kill("SIGTERM");
  assert.equal(await deadline(launcherExit, "production launcher stop"), 143);
  assert.deepEqual(
    await readdir(launcherRoot),
    [],
    "launcher removes both private sockets",
  );
  assert.equal(
    execFileSync(
      "docker",
      ["ps", "-a", "--filter", `volume=${launcherRoot}`, "--format", "{{.ID}}"],
      { encoding: "utf8" },
    ).trim(),
    "",
    "launcher removes its native container",
  );
  console.log(
    "Production launcher SIGTERM removed native container, relay and private sockets; no provider prompt.",
  );
} catch (error) {
  process.stderr.write(launcherLogs);
  throw error;
} finally {
  control?.destroy();
  if (!launcherStopped) launcher.kill("SIGTERM");
  await launcherExit;
  await rm(launcherRoot, { recursive: true, force: true });
}
