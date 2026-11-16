import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { waitFor } from "../../scripts/processes.mjs";

const execute = promisify(execFile);
const binary = resolve(
  `target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-open-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const token = randomBytes(32).toString("hex");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const base = `http://127.0.0.1:${port}/v1`;
  const env = {
    ...process.env,
    SCENESPARROW_PROJECT_DIR: join(root, "project"),
    SCENESPARROW_APP_DATA_DIR: join(root, "settings"),
    SCENESPARROW_SESSION_TOKEN: token,
    SCENESPARROW_CORE_PORT: String(port),
  };
  delete env.SCENESPARROW_PROJECT_OPEN_MODE;
  async function launch(mode) {
    const child = spawn(binary, [], {
      env: {
        ...env,
        ...(mode ? { SCENESPARROW_PROJECT_OPEN_MODE: mode } : {}),
      },
      stdio: "pipe",
    });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, "exit");
      child.kill("SIGINT");
      await exit;
    };
    t.after(stop);
    await waitFor(`${base}/health`, headers, child);
    return stop;
  }
  return { root, env, base, headers, launch };
}
async function refuses(env) {
  await assert.rejects(execute(binary, [], { env, timeout: 5000 }), (error) => {
    // A process that initialized a replacement and stayed alive would hit the timeout.
    assert.equal(error.killed, false);
    assert.ok(Number.isInteger(error.code) && error.code !== 0);
    return true;
  });
}

test("real child refuses deleted/moved remembered databases and directories after successful inspection", async (t) => {
  for (const mutation of [
    "delete-database",
    "move-database",
    "delete-directory",
    "move-directory",
  ]) {
    const f = await fixture(t);
    const directory = f.env.SCENESPARROW_PROJECT_DIR;
    const stop = await f.launch("create");
    const response = await fetch(`${f.base}/project/ensure`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        requestId: "existing-race",
        title: "Original project 中文",
      }),
    });
    assert.equal(response.status, 200);
    await stop();
    await execute(binary, ["--inspect-project", directory], { env: f.env });
    const database = join(directory, "project.sqlite");
    const before = await readFile(database);
    const moved = join(f.root, "preserved-original");
    if (mutation === "delete-database") await rm(database);
    else if (mutation === "move-database") await rename(database, moved);
    else if (mutation === "delete-directory")
      await rm(directory, { recursive: true });
    else await rename(directory, moved);
    await refuses({ ...f.env, SCENESPARROW_PROJECT_OPEN_MODE: "existing" });
    assert.equal(existsSync(database), false, mutation);
    if (mutation.endsWith("directory"))
      assert.equal(existsSync(directory), false, mutation);
    if (mutation === "move-database")
      assert.deepEqual(await readFile(moved), before);
    if (mutation === "move-directory")
      assert.deepEqual(await readFile(join(moved, "project.sqlite")), before);
  }
});

test("existing mode refuses schema zero unchanged and invalid modes create no project directory", async (t) => {
  const f = await fixture(t);
  const directory = f.env.SCENESPARROW_PROJECT_DIR;
  await mkdir(directory);
  const database = join(directory, "project.sqlite");
  await writeFile(database, new Uint8Array());
  await refuses({ ...f.env, SCENESPARROW_PROJECT_OPEN_MODE: "existing" });
  assert.equal((await readFile(database)).length, 0);
  assert.equal(existsSync(join(directory, "objects")), false);
  await rm(directory, { recursive: true });
  for (const mode of ["", "Existing", "overwrite", "existing/create"])
    await refuses({ ...f.env, SCENESPARROW_PROJECT_OPEN_MODE: mode });
  assert.equal(existsSync(directory), false);
});

test("unset/create mode preserves CLI initialization and existing mode reopens acknowledged identity", async (t) => {
  for (const mode of [undefined, "create"]) {
    const f = await fixture(t);
    const stop = await f.launch(mode);
    const response = await fetch(`${f.base}/project/ensure`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        requestId: "compatibility",
        title: "Preserved CLI project",
      }),
    });
    assert.equal(response.status, 200);
    const original = await response.json();
    await stop();
    const stopExisting = await f.launch("existing");
    assert.deepEqual(
      await (await fetch(`${f.base}/project`, { headers: f.headers })).json(),
      original,
    );
    await stopExisting();
  }
});
