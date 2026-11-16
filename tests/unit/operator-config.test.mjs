import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { operatorConfiguration } from "../../scripts/web/operator-config.mjs";
import { readOperator } from "../../scripts/web/gateway.mjs";

test("operator pair overrides legacy, rejects partial pairs and enforces shared ASCII bounds", async () => {
  const password = "memorable-pass16";
  assert.equal(password.length, 16);
  const pair = { OPERATOR_USERNAME: "Operator_1", OPERATOR_PASSWORD: password };
  assert.equal(operatorConfiguration(pair), `Operator_1:${password}`);
  assert.equal(
    operatorConfiguration({ ...pair, OPERATOR_AUTH: "invalid" }),
    `Operator_1:${password}`,
  );
  assert.equal(
    operatorConfiguration({ OPERATOR_AUTH: `legacy:${password}\n` }),
    `legacy:${password}`,
  );
  assert.equal(operatorConfiguration({}), undefined);
  for (const partial of [
    { OPERATOR_USERNAME: "operator" },
    { OPERATOR_PASSWORD: password },
  ])
    assert.throws(() =>
      operatorConfiguration({
        ...partial,
        OPERATOR_AUTH: `legacy:${password}`,
      }),
    );
  for (const username of ["bad:name", "é", "with space", "a".repeat(65)])
    assert.throws(() =>
      operatorConfiguration({ ...pair, OPERATOR_USERNAME: username }),
    );
  for (const invalid of [
    "a".repeat(15),
    "a".repeat(257),
    "pass with spaces",
    "é".repeat(16),
    "a".repeat(16) + "\n",
  ])
    assert.throws(() =>
      operatorConfiguration({ ...pair, OPERATOR_PASSWORD: invalid }),
    );
  assert.ok(
    operatorConfiguration({
      OPERATOR_USERNAME: "a".repeat(64),
      OPERATOR_PASSWORD: "a".repeat(256),
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-operator-"));
  try {
    for (const value of [`operator:${password}`, `operator:${password}\n`]) {
      await writeFile(join(directory, "auth"), value);
      assert.equal((await readOperator(join(directory, "auth"))).length, 32);
    }
    await writeFile(join(directory, "auth"), "operator:" + "a".repeat(15));
    await assert.rejects(readOperator(join(directory, "auth")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete or invalid deployment auth fails before any SSH without secret output", () => {
  for (const auth of [
    { OPERATOR_USERNAME: "partial" },
    { OPERATOR_PASSWORD: "private-do-not-log" },
    { OPERATOR_USERNAME: "operator", OPERATOR_PASSWORD: "short-private" },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/web/deploy-client.mjs"],
      { encoding: "utf8", env: { PATH: "/nonexistent", ...auth } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operator/);
    assert.doesNotMatch(
      result.stderr,
      /private-do-not-log|short-private|spawnSync ssh/,
    );
  }
});
