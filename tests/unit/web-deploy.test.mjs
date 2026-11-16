import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  mkdir,
  rm,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("deployment validates and pulls before downtime, refuses live backups and preserves failed migration backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-deploy-test-"));
  const directory = join(root, "server");
  const bin = join(root, "bin");
  const log = join(root, "calls");
  await mkdir(bin);
  await mkdir(directory);
  await writeFile(join(directory, "compose.yaml"), "old-compose");
  await writeFile(join(directory, "runtime.env"), "old-config");
  await mkdir(join(directory, "secrets"));
  await writeFile(
    join(directory, "secrets", "operator-auth"),
    "operator:" + "a".repeat(40),
  );
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
if [[ $1 == login ]]; then cat >/dev/null; fi
if [[ $1 == ps && \$TEST_RUNNING == 1 ]]; then echo container-still-running; fi
if [[ $* == *' pull '* && \$TEST_PULL_FAIL == 1 ]]; then exit 1; fi
if [[ $* == *' up '* && \$TEST_UP_FAIL == 1 ]]; then exit 1; fi
`,
    { mode: 0o755 },
  );
  const attempt = async (options = {}) => {
    const incoming = await mkdtemp("/tmp/scenesparrow-deploy.");
    await copyFile("deploy/compose.yaml", join(incoming, "compose.yaml"));
    await writeFile(
      join(incoming, "config.json"),
      JSON.stringify({
        image: "ghcr.io/example/scenesparrow/web@sha256:" + "a".repeat(64),
        origin: "https://scene.example",
        directory,
        port: 8070,
        actor: "operator",
      }),
    );
    if (options.secret)
      await writeFile(join(incoming, "operator-auth"), options.secret);
    await writeFile(log, "");
    const result = spawnSync("bash", ["deploy/deploy.sh", incoming], {
      encoding: "utf8",
      input: "synthetic-registry-token",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log,
        TEST_RUNNING: options.running ? "1" : "0",
        TEST_PULL_FAIL: options.pullFail ? "1" : "0",
        TEST_UP_FAIL: options.upFail ? "1" : "0",
      },
    });
    return { ...result, calls: await readFile(log, "utf8") };
  };
  try {
    const invalid = await attempt({ secret: "operator:" + "x".repeat(15) });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.calls, "");
    assert.doesNotMatch(invalid.stderr, /x{15}/);
    const rejected = await attempt({
      pullFail: true,
      secret: "operator:" + "b".repeat(40),
    });
    assert.equal(rejected.status, 1);
    assert.doesNotMatch(rejected.calls, / stop | up |run --rm/);
    assert.match(
      await readFile(join(directory, "secrets", "operator-auth"), "utf8"),
      /a{40}/,
    );
    const live = await attempt({ running: true });
    assert.equal(live.status, 1);
    assert.doesNotMatch(live.calls, /run --rm| up /);
    const failed = await attempt({ upFail: true });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /No database restore or image rollback/);
    assert.ok(failed.calls.indexOf(" pull ") < failed.calls.indexOf(" stop "));
    assert.ok(
      failed.calls.indexOf(" stop ") < failed.calls.indexOf("run --rm"),
    );
    assert.ok(failed.calls.indexOf("run --rm") < failed.calls.indexOf(" up "));
    assert.match(failed.calls, /up -d --force-recreate --pull never --wait/);
    assert.doesNotMatch(
      failed.calls,
      /synthetic-registry-token|system prune|volume rm/,
    );
    const backups = await readdir(join(directory, "backups"));
    assert.equal(backups.length, 1);
    assert.equal(
      await readFile(
        join(directory, "backups", backups[0], "runtime.env"),
        "utf8",
      ),
      "old-config",
    );
    const success = await attempt({ secret: "operator:" + "c".repeat(16) });
    assert.equal(success.status, 0, success.stderr);
    assert.match(
      await readFile(join(directory, "secrets", "operator-auth"), "utf8"),
      /c{16}/,
    );
    assert.equal((await readdir(join(directory, "backups"))).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
