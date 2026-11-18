import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { operatorConfiguration } from "../../scripts/web/operator-config.mjs";
import { readOperator } from "../../apps/web/server/gateway.mjs";

test("operator pair overrides legacy, rejects partial pairs and enforces shared ASCII bounds", async () => {
  const password = "pass6!";
  assert.equal(password.length, 6);
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
    "a".repeat(5),
    "a".repeat(257),
    "pass with spaces",
    "é".repeat(6),
    "aaa\naaa",
    password + "\n",
    password + "\x7f",
  ])
    assert.throws(
      () => operatorConfiguration({ ...pair, OPERATOR_PASSWORD: invalid }),
      { message: "Invalid operator configuration" },
    );
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-operator-"));
  try {
    for (const length of [6, 16, 32, 256]) {
      const accepted = "a".repeat(length);
      for (const username of ["a", "a".repeat(64)]) {
        const credential = `${username}:${accepted}`;
        assert.equal(
          operatorConfiguration({
            OPERATOR_USERNAME: username,
            OPERATOR_PASSWORD: accepted,
          }),
          credential,
        );
        for (const value of [credential, credential + "\n"]) {
          assert.equal(
            operatorConfiguration({ OPERATOR_AUTH: value }),
            credential,
          );
          await writeFile(join(directory, "auth"), value);
          assert.equal(
            (await readOperator(join(directory, "auth"))).length,
            32,
          );
        }
      }
    }
    for (const invalid of [
      "a".repeat(5),
      "a".repeat(257),
      "with space",
      "é".repeat(6),
      "aaa\naaa",
      password + "\n\n",
      password + "\x7f",
    ]) {
      assert.throws(
        () => operatorConfiguration({ OPERATOR_AUTH: `operator:${invalid}` }),
        { message: "Invalid operator configuration" },
      );
      await writeFile(join(directory, "auth"), `operator:${invalid}`);
      await assert.rejects(readOperator(join(directory, "auth")), {
        message: "Invalid operator configuration",
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("incomplete or invalid deployment auth fails before any SSH without secret output", () => {
  for (const auth of [
    { OPERATOR_USERNAME: "partial" },
    { OPERATOR_PASSWORD: "private-do-not-log" },
    { OPERATOR_USERNAME: "operator", OPERATOR_PASSWORD: "pvte5" },
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
      /private-do-not-log|pvte5|spawnSync ssh/,
    );
  }
});
