import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { readOperator } from "../../apps/web/server/gateway.mjs";
import { startRuntime } from "../../apps/web/server/start.mjs";
import { validateMasterKeyFile } from "../../apps/web/server/master-key.mjs";

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

test(
  "web supervisor quiesces before SIGINT and cleans up failed startup and child death",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scenesparrow-runtime-"));
    const fake = join(directory, "core.mjs");
    await writeFile(join(directory, "auth"), "operator:" + "r".repeat(40));
    await writeFile(join(directory, "index.html"), "web");
    await writeFile(
      fake,
      `
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const log = process.env.SCENESPARROW_PROJECT_DIR + '/lifecycle';
writeFileSync(log, String(process.pid) + '\\n');
writeFileSync(process.env.SCENESPARROW_PROJECT_DIR + '/core-env.json', JSON.stringify(process.env));
if (process.env.OPERATOR_AUTH || process.env.OPERATOR_AUTH_FILE) process.exit(8);
const s = createServer((req,res) => {
  if(req.url.endsWith('/quiesce')) {
    if(req.headers.authorization !== 'Bearer '+process.env.SCENESPARROW_SESSION_TOKEN || req.headers['x-scenesparrow-native'] !== process.env.SCENESPARROW_NATIVE_TOKEN) process.exit(9);
    appendFileSync(log,'quiesce\\n');
  }
  res.end('{}');
});
s.listen(Number(process.env.SCENESPARROW_CORE_PORT),'127.0.0.1');
process.on('SIGINT',()=>{appendFileSync(log,'SIGINT\\n');s.close(()=>process.exit(0));});
`,
    );
    const exits = [];
    const signals = new EventEmitter();
    const config = {
      origin: "https://scene.example",
      operator: await readOperator(join(directory, "auth")),
      binary: process.execPath,
      args: [fake],
      staticRoot: directory,
      gatewayPort: 0,
      projectDir: directory,
      appDataDir: directory,
      signals,
      onExit: (code) => exits.push(code),
      startupMs: 2000,
      shutdownMs: 2000,
      quiesceMs: 1000,
    };
    let runtime;
    try {
      runtime = await startRuntime({ ...config, corePort: await port() });
      signals.emit("SIGTERM");
      await runtime.stop();
      assert.match(
        await readFile(join(directory, "lifecycle"), "utf8"),
        /quiesce\nSIGINT\n$/,
      );
      assert.equal(exits.at(-1), 0);
      assert.equal(runtime.child.exitCode, 0);

      const markdownProjectsDir = join(directory, "markdown-projects");
      runtime = await startRuntime({
        ...config,
        corePort: await port(),
        markdownProjectsDir,
      });
      const fileEnv = JSON.parse(
        await readFile(join(directory, "core-env.json"), "utf8"),
      );
      assert.equal(
        fileEnv.SCENESPARROW_MARKDOWN_PROJECTS_DIR,
        markdownProjectsDir,
      );
      await runtime.stop();
      assert.match(
        await readFile(join(directory, "lifecycle"), "utf8"),
        /\nSIGINT\n$/,
      );
      assert.ok(
        !(await readFile(join(directory, "lifecycle"), "utf8")).includes(
          "quiesce",
        ),
      );
      assert.equal(exits.at(-1), 0);

      const masterKeyFile = join(directory, "master-key");
      const encoded = Buffer.alloc(32, 9).toString("base64");
      await writeFile(masterKeyFile, encoded + "\n", { mode: 0o444 });
      runtime = await startRuntime({
        ...config,
        masterKeyFile,
        corePort: await port(),
      });
      const coreEnv = JSON.parse(
        await readFile(join(directory, "core-env.json"), "utf8"),
      );
      assert.equal(coreEnv.SCENESPARROW_AI_MASTER_KEY_FILE, masterKeyFile);
      assert.ok(!JSON.stringify(coreEnv).includes(encoded));
      assert.equal(coreEnv.OPERATOR_AUTH_FILE, undefined);
      await runtime.stop();

      await assert.rejects(
        startRuntime({
          ...config,
          corePort: await port(),
          staticRoot: join(directory, "missing"),
        }),
      );
      const pid = Number(
        (await readFile(join(directory, "lifecycle"), "utf8")).split("\n")[0],
      );
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(exits.at(-1), 1);

      const occupied = createServer();
      occupied.listen(0, "0.0.0.0");
      await once(occupied, "listening");
      try {
        await assert.rejects(
          startRuntime({
            ...config,
            corePort: await port(),
            gatewayPort: occupied.address().port,
          }),
        );
      } finally {
        await new Promise((done) => occupied.close(done));
      }
      assert.equal(exits.at(-1), 1);

      runtime = await startRuntime({ ...config, corePort: await port() });
      const dead = once(runtime.child, "exit");
      runtime.child.kill("SIGKILL");
      await dead;
      await runtime.stop();
      assert.equal(exits.at(-1), 1);
      await assert.rejects(
        startRuntime({
          ...config,
          corePort: await port(),
          binary: join(directory, "missing-binary"),
        }),
      );
      assert.equal(exits.at(-1), 1);
    } finally {
      await runtime?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("configured master keys are bounded regular files and validation errors redact values and paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-master-test-"));
  const path = join(directory, "SYNTHETIC_LOCATOR_CANARY");
  try {
    for (const value of [
      "SYNTHETIC_INVALID_KEY_CANARY",
      "x".repeat(129),
      Buffer.alloc(31).toString("base64"),
    ]) {
      await writeFile(path, value, { mode: 0o600 });
      await assert.rejects(validateMasterKeyFile(path), (error) => {
        assert.equal(error.message, "AI credential configuration unavailable");
        return true;
      });
    }
    await writeFile(path, Buffer.alloc(32, 4).toString("base64"));
    await validateMasterKeyFile(path);
    await assert.rejects(
      validateMasterKeyFile(directory),
      /AI credential configuration unavailable/,
    );
    const alias = join(directory, "alias");
    if (process.platform !== "win32") {
      await symlink(path, alias);
      await assert.rejects(
        validateMasterKeyFile(alias),
        /AI credential configuration unavailable/,
      );
    }
    await rm(path);
    await assert.rejects(
      validateMasterKeyFile(path),
      /AI credential configuration unavailable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
