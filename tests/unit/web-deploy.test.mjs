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
  stat,
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
if [[ $1 == volume && $2 == ls ]]; then
  if [[ \$TEST_VOLUME_ERROR == 1 ]]; then exit 1; fi
  if [[ \$TEST_VOLUME_EXISTS == 1 ]]; then echo scenesparrow-appdata; fi
fi
if [[ $1 == volume && $2 == inspect && \$TEST_VOLUME_EXISTS == 0 ]]; then exit 1; fi
if [[ $* == *'--entrypoint node'* && \$TEST_VAULT == 1 ]]; then exit 42; fi
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
        runnerImage:
          "ghcr.io/example/scenesparrow/deepseek@sha256:" + "b".repeat(64),
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
        TEST_VOLUME_EXISTS: options.noVolumes ? "0" : "1",
        TEST_VAULT: options.vault ? "1" : "0",
        TEST_VOLUME_ERROR: options.volumeError ? "1" : "0",
      },
    });
    return { ...result, calls: await readFile(log, "utf8") };
  };
  try {
    for (const password of [
      "x".repeat(5),
      "x".repeat(257),
      "with space",
      "é".repeat(6),
      "xxx\nxxx",
      "xxxxxx\n\n",
      "xxxxxx\x7f",
    ]) {
      const invalid = await attempt({ secret: `operator:${password}` });
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.calls, "");
      assert.match(invalid.stderr, /Invalid operator configuration/);
      assert.ok(!invalid.stderr.includes(password));
    }
    await writeFile(
      join(directory, "secrets", "operator-auth"),
      "operator:pvte5",
    );
    const provisioned = await attempt();
    assert.notEqual(provisioned.status, 0);
    assert.equal(provisioned.calls, "");
    assert.doesNotMatch(provisioned.stderr, /pvte5/);
    await writeFile(
      join(directory, "secrets", "operator-auth"),
      "operator:" + "a".repeat(40),
    );
    for (const length of [16, 32, 256]) {
      const password = "d".repeat(length);
      const accepted = await attempt({
        secret: `operator:${password}\n`,
        pullFail: true,
      });
      assert.equal(accepted.status, 1);
      assert.match(accepted.calls, / pull /);
      assert.ok(!accepted.stderr.includes(password));
      assert.ok(!accepted.calls.includes(password));
    }
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
    assert.doesNotMatch(live.calls, /--entrypoint tar| up /);
    const masterFile = join(directory, "secrets", "ai-master-key");
    const master = await readFile(masterFile, "utf8");
    assert.equal(Buffer.from(master.trim(), "base64").length, 32);
    assert.equal((await stat(masterFile)).mode & 0o777, 0o444);
    assert.equal((await stat(join(directory, "secrets"))).mode & 0o777, 0o700);
    await rm(masterFile);
    const daemonFailure = await attempt({ volumeError: true });
    assert.notEqual(daemonFailure.status, 0);
    assert.match(daemonFailure.stderr, /master key was not generated/);
    await assert.rejects(readFile(masterFile), { code: "ENOENT" });
    const lost = await attempt({ vault: true });
    assert.equal(lost.status, 1);
    assert.match(lost.stderr, /Restore its original master key/);
    assert.doesNotMatch(lost.calls, / stop | up |--entrypoint tar/);
    await assert.rejects(readFile(masterFile), { code: "ENOENT" });
    await writeFile(masterFile, "INVALID_MASTER_CANARY", { mode: 0o444 });
    const malformed = await attempt();
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.calls, "");
    assert.doesNotMatch(malformed.stderr, /INVALID_MASTER_CANARY/);
    await rm(masterFile);
    // A first deployment with no volumes generates a key without creating a
    // volume merely to inspect it, even if a later live-container guard fails.
    const first = await attempt({ noVolumes: true, running: true });
    assert.equal(first.status, 1);
    assert.doesNotMatch(first.calls, /run --rm|volume create/);
    const generated = await readFile(masterFile, "utf8");
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
    const success = await attempt({ secret: "operator:" + "c".repeat(6) });
    assert.equal(success.status, 0, success.stderr);
    assert.match(
      await readFile(join(directory, "secrets", "operator-auth"), "utf8"),
      /c{6}/,
    );
    const pairedBackups = await readdir(join(directory, "backups"));
    assert.equal(pairedBackups.length, 2);
    const previousEnvironments = await Promise.all(
      pairedBackups.map((backup) =>
        readFile(join(directory, "backups", backup, "runtime.env"), "utf8"),
      ),
    );
    assert(
      previousEnvironments.includes("old-config"),
      "pre-Harness single-image config remains intact",
    );
    assert(
      previousEnvironments.some(
        (environment) =>
          /SCENESPARROW_IMAGE=.*@sha256:a{64}/.test(environment) &&
          /SCENESPARROW_DSH_IMAGE=.*@sha256:b{64}/.test(environment),
      ),
      "paired image identities survive the next rollback backup",
    );
    assert.equal(await readFile(masterFile, "utf8"), generated);
    const runtimeEnv = await readFile(join(directory, "runtime.env"), "utf8");
    assert.match(
      runtimeEnv,
      /SCENESPARROW_DSH_IMAGE=ghcr.io\/example\/scenesparrow\/deepseek@sha256:b{64}/,
    );
    assert.match(runtimeEnv, /AI_MASTER_KEY_FILE=.*\/secrets\/ai-master-key/);
    for (const value of [master.trim(), generated.trim()]) {
      assert.ok(!runtimeEnv.includes(value));
      assert.ok(
        !(success.stdout + success.stderr + success.calls).includes(value),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
