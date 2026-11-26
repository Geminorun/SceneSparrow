// Trusted ACP transport; run only with run-deepseek-isolated.sh.
import { createServer as createSocketServer } from "node:net";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { providerProxy } from "./relay.mjs";
import {
  VERSION,
  MAX_INPUT,
  MAX_OUTPUT,
  DEADLINE,
  SOCKET_ROOT,
  credentialHandshake,
  admit,
  encode,
} from "./policy.mjs";

const status = await readFile("/proc/self/status", "utf8");
const mounts = await readFile("/proc/self/mountinfo", "utf8");
if (
  process.getuid() === 0 ||
  !/^NoNewPrivs:\s+1$/m.test(status) ||
  !/^CapEff:\s+0+$/m.test(status) ||
  !mounts.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === "/" && fields[5].split(",").includes("ro");
  }) ||
  (await readdir("/sys/class/net")).some((name) => name !== "lo")
)
  throw Error(
    "Writing runner requires a nonroot read-only network-disabled OS sandbox",
  );
process.umask(0o077);
await mkdir("/tmp/writing", { mode: 0o700 });
const proxy = providerProxy((options, callback) =>
  request({ ...options, socketPath: `${SOCKET_ROOT}/provider.sock` }, callback),
);
await new Promise((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(48191, "127.0.0.1", resolve);
});
function drain(stream) {
  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };
    stream.once("drain", done);
    stream.once("close", done);
    if (stream.destroyed) done();
  });
}
const children = new Set();
let clients = 0;
const server = createSocketServer(async (stream) => {
  if (clients >= 4) {
    stream.destroy();
    return;
  }
  clients++;
  let directory;
  let child;
  let stopped = false;
  let force;
  let input = 0;
  let output = 0;
  let wireOutput = 0;
  let apiKey;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.destroy();
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Exited. */
      }
      force = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Exited. */
        }
      }, 250);
    }
  };
  const send = async (message) => {
    const line = encode(message, apiKey) + "\n";
    wireOutput += Buffer.byteLength(line);
    if (wireOutput > MAX_OUTPUT || stopped) {
      stop();
      return;
    }
    if (!stream.write(line)) await drain(stream);
  };
  const timer = setTimeout(stop, DEADLINE);
  const handshakeTimer = setTimeout(stop, 5000);
  children.add(stop);
  stream.on("error", stop);
  stream.on("close", stop);
  stream.on("data", (chunk) => {
    input += chunk.length;
    if (input > MAX_INPUT) stop();
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    const iterator = lines[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || stopped) return;
    apiKey = credentialHandshake(JSON.parse(first.value));
    clearTimeout(handshakeTimer);
    directory = await mkdtemp("/tmp/dsh-home-");
    const profile = `${directory}/profiles/writing`;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      `${profile}/package.json`,
      await readFile("/opt/dsh/profile.json"),
    );
    await writeFile(
      `${profile}/cordis.patch.yml`,
      (await readFile("/opt/dsh/writing.patch.yml", "utf8")).replace(
        "/tmp/unused",
        `${directory}/sessions`,
      ),
    );
    if (stopped) return;
    child = spawn(
      "/usr/local/bin/node",
      [
        "/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
        "--profile",
        "writing",
      ],
      {
        cwd: "/tmp/writing",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: directory,
          DSH_HOME: directory,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: "C.UTF-8",
          DSH_TELEMETRY_DISABLED: "1",
          NARB_DISABLE_NATIVE_CACHE: "1",
          DSH_INVENTORY_FILE: `${directory}/inventory.json`,
          ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
        },
      },
    );
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stderr.resume(); // Provider diagnostics may contain credentials or document text.
    const nativeLines = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.length;
      if (output > MAX_OUTPUT) stop();
    });
    const replies = (async () => {
      try {
        for await (const line of nativeLines) {
          const message = JSON.parse(line);
          if (message.method && message.method !== "session/update") {
            stop();
            break;
          }
          // Native ACP advertises generic MCP features; this deployment admits none.
          if (message.result?.agentCapabilities) {
            message.result.agentCapabilities = {
              promptCapabilities: {
                image: false,
                audio: false,
                embeddedContext: false,
              },
              sessionCapabilities: { close: {} },
            };
          }
          await send(message);
        }
      } catch {
        stop();
      }
    })();
    await send({
      protocolVersion: 1,
      ready: true,
      engine: "deepseek",
      packageVersion: VERSION,
      credentialPresent: apiKey !== null,
    });
    const inputs = (async () => {
      for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
        if (stopped) break;
        const message = JSON.parse(line);
        if (!admit(message)) {
          if (message.id !== undefined)
            await send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32602,
                message: "Writing profile rejects this operation",
              },
            });
          continue;
        }
        if (!child.stdin.write(JSON.stringify(message) + "\n"))
          await drain(child.stdin);
      }
      stop();
    })().catch(stop);
    await exited;
    stop();
    await Promise.all([inputs, replies]);
  } catch {
    stop();
  } finally {
    stop();
    clearTimeout(timer);
    clearTimeout(handshakeTimer);
    clearTimeout(force);
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Exited. */
      }
    }
    children.delete(stop);
    lines.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    clients--;
  }
});
server.on("error", () => {
  process.exitCode = 1;
  for (const stop of children) stop();
  proxy.close();
  proxy.closeAllConnections();
});
const socket = `${SOCKET_ROOT}/dsh.sock`;
server.listen(socket, async () => {
  await chmod(socket, 0o600);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    for (const stop of children) stop();
    proxy.close();
    proxy.closeAllConnections();
  });
