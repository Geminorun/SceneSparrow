// Trusted transport only. Run with run-codex-isolated.sh; never in the app container.
import { constants } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  open,
  readdir,
} from "node:fs/promises";

const socket = "/run/writing-agent/codex.sock";
const status = await readFile("/proc/self/status", "utf8");
const mounts = await readFile("/proc/self/mountinfo", "utf8");
if (
  process.getuid() === 0 ||
  !/^NoNewPrivs:\s+1$/m.test(status) ||
  !/^CapEff:\s+0+$/m.test(status) ||
  !mounts.split("\n").some((line) => {
    const fields = line.split(" ");
    return fields[4] === "/" && fields[5].split(",").includes("ro");
  })
)
  throw Error("Writing runner requires an unprivileged read-only OS sandbox");
if ((await readdir("/run/codex-auth")).some((name) => name !== "auth.json"))
  throw Error("Writing runner requires a dedicated auth-only directory");
await mkdir("/tmp/writing", { mode: 0o700 });
let clients = 0;
const children = new Set();
const server = createServer(async (stream) => {
  if (clients >= 4) {
    stream.destroy();
    return;
  }
  clients++;
  let directory;
  let child;
  let timer;
  let force;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.destroy();
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
      force = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }, 250);
    }
  };
  stream.on("error", stop);
  stream.on("close", stop);
  try {
    directory = await mkdtemp("/tmp/writing-home-");
    // The only operator-owned input is dedicated Codex auth, never operator config or environment.
    try {
      const authPath = "/run/codex-auth/auth.json";
      const auth = await open(
        authPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await auth.stat();
        if (!metadata.isFile() || metadata.size > 1024 * 1024)
          throw Error("Invalid dedicated auth");
        const content = Buffer.alloc(metadata.size);
        const { bytesRead } = await auth.read(content, 0, content.length, 0);
        if (bytesRead !== metadata.size) throw Error("Invalid dedicated auth");
        await writeFile(`${directory}/auth.json`, content, { mode: 0o600 });
      } finally {
        await auth.close();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(
      `${directory}/config.toml`,
      [
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        "model_providers.openai.request_max_retries = 0",
        "model_providers.openai.stream_max_retries = 0",
        'shell_environment_policy.inherit = "none"',
      ].join("\n"),
      { mode: 0o600 },
    );
    if (stopped) return;
    child = spawn(
      "/opt/codex/bin/codex",
      [
        "app-server",
        "--listen",
        "stdio://",
        ...[
          "shell_tool",
          "unified_exec",
          "multi_agent",
          "goals",
          "view_image",
          "image_generation",
        ].flatMap((feature) => ["--disable", feature]),
      ],
      {
        cwd: "/tmp/writing",
        env: {
          HOME: directory,
          CODEX_HOME: directory,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    children.add(stop);
    child.stderr.resume(); // Native stderr may contain credentials or provider text; discard it.
    child.stdin.on("error", stop);
    child.on("error", stop);
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop();
    });
    let inputBytes = 0;
    stream.on("data", (chunk) => {
      inputBytes += chunk.length;
      if (inputBytes > 2 * 1024 * 1024) stop();
    });
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
    timer = setTimeout(stop, 125_000);
    await new Promise((done) => {
      child.once("exit", done);
      child.once("error", done);
    });
  } catch {
    stop();
  } finally {
    stop();
    clearTimeout(timer);
    // Ensure descendants are gone even if the native parent exited first.
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Exited. */
      }
    }
    clearTimeout(force);
    children.delete(stop);
    if (directory) await rm(directory, { recursive: true, force: true });
    clients--;
  }
});
server.on("error", () => {
  process.exitCode = 1;
  for (const stop of children) stop();
});
server.listen(socket, () => {});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    for (const stop of children) stop();
  });
