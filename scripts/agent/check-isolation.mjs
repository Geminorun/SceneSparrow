// Explicit Docker/native smoke only: no authentication or model turn is used.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const binary = process.argv[2];
if (!binary?.startsWith("/"))
  throw Error("Usage: node scripts/agent/check-isolation.mjs ABS_CODEX_BINARY");
const launcher = new URL("./run-codex-isolated.sh", import.meta.url).pathname;
const root = await mkdtemp("/tmp/ewa-isolation-");
const socketDir = root + "/socket",
  authDir = root + "/auth";
const { mkdir } = await import("node:fs/promises");
await mkdir(socketDir, { mode: 0o700 });
await mkdir(authDir, { mode: 0o700 });
await writeFile(root + "/host-only-marker", "HOST_PRIVATE");
const child = spawn("bash", [launcher, socketDir, authDir, binary], {
  env: {
    ...process.env,
    SCENESPARROW_SESSION_TOKEN: "SENTINEL_MUST_NOT_REACH_RUNNER",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise((done) => {
  child.once("exit", done);
  child.once("error", done);
});
child.stdout.resume();
child.stderr.on("data", (b) => process.stderr.write(b));
let container;
try {
  let socket;
  for (let n = 0; n < 450; n++) {
    socket = await new Promise((resolve) => {
      const s = createConnection(socketDir + "/codex.sock");
      s.once("error", () => resolve(null));
      s.once("connect", () => resolve(s));
    });
    if (socket) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(socket, "isolated socket ready");
  socket.write(
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ewa-isolation-test", version: "1" } },
    }) + "\n",
  );
  let accountSeen = false;
  const handshake = setTimeout(() => socket.destroy(), 8000);
  try {
    for await (const line of createInterface({ input: socket })) {
      const m = JSON.parse(line);
      if (m.id === 1) {
        assert(m.result);
        socket.write(
          JSON.stringify({ method: "initialized" }) +
            "\n" +
            JSON.stringify({
              id: 2,
              method: "account/read",
              params: { refreshToken: false },
            }) +
            "\n",
        );
      }
      if (m.id === 2) {
        assert.equal(m.result.requiresOpenaiAuth, true);
        assert.equal(m.result.account, null);
        accountSeen = true;
        break;
      }
    }
  } finally {
    clearTimeout(handshake);
    socket.destroy();
  }
  assert(accountSeen, "native account/read reply received within deadline");
  container = execFileSync(
    "docker",
    ["ps", "--filter", `volume=${socketDir}`, "--format", "{{.ID}}"],
    { encoding: "utf8" },
  ).trim();
  assert(container);
  const details = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
  )[0];
  assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(details.HostConfig.CapDrop, ["ALL"]);
  assert(details.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal(details.Mounts.length, 4);
  const check = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.equal(process.env.SCENESPARROW_SESSION_TOKEN,undefined);for(const p of ['/opt/writing-runner.mjs','/opt/codex/bin/codex']){assert.throws(()=>fs.writeFileSync(p,'bad'),e=>e.code==='EROFS'||e.code==='EACCES')}assert.equal(fs.existsSync(${JSON.stringify(root + "/host-only-marker")}),false);fs.writeFileSync('/tmp/allowed','ok');console.log('OS boundary: root read-only, host marker absent, app token absent, scratch writable');`;
  process.stdout.write(
    execFileSync("docker", ["exec", container, "node", "-e", check], {
      encoding: "utf8",
    }),
  );
  console.log(
    "Actual Codex initialize/account read passed; no model turn or credentials used.",
  );
} finally {
  if (!container)
    container = execFileSync(
      "docker",
      ["ps", "-a", "--filter", `volume=${socketDir}`, "--format", "{{.ID}}"],
      { encoding: "utf8" },
    ).trim();
  if (container)
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  else child.kill("SIGTERM");
  await exited;
  await rm(root, { recursive: true, force: true });
}
