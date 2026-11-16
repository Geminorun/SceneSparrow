import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releasePolicy, git } from "../../scripts/release/policy.mjs";
import {
  applicationVersion,
  setVersion,
} from "../../scripts/release/version.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scenesparrow-release-"));
  const run = (args) => git(args, root);
  for (const dir of ["apps", "packages", "workers"])
    await mkdir(join(root, dir));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, version: "1.0.0" }),
  );
  await writeFile(
    join(root, "Cargo.toml"),
    '[workspace.package]\nversion = "1.0.0"\n# independent protocol 0.1.0\n',
  );
  await writeFile(
    join(root, "Cargo.lock"),
    ["application", "domain", "infrastructure", "service"]
      .map(
        (name) =>
          `[[package]]\nname = "scenesparrow-${name}"\nversion = "1.0.0"\n`,
      )
      .join("\n") + '\n[[package]]\nname = "external"\nversion = "0.1.0"\n',
  );
  run(["init", "--initial-branch=main"]);
  run([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "add",
    ".",
  ]);
  run([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  const sha = run(["rev-parse", "HEAD"]);
  run(["remote", "add", "origin", root]);
  run(["update-ref", "refs/heads/release/1.0.0", sha]);
  run(["update-ref", "refs/tags/v1.0.0", sha]);
  run(["update-ref", "refs/tags/v1.0.0-rc.1", sha]);
  const policy = (options) =>
    releasePolicy(
      { event: "push", ref: "refs/heads/main", sha, ...options },
      { root, run },
    );
  return { root, run, sha, policy };
}

test("release ref matrix validates versions and exact remote event commit with actual Git history", async () => {
  const { root, run, sha, policy } = await fixture();
  try {
    assert.equal((await policy({})).should_deploy, "false");
    for (const [ref, channel] of [
      ["refs/heads/release/1.0.0", "candidate"],
      ["refs/tags/v1.0.0", "stable"],
      ["refs/tags/v1.0.0-rc.1", "rc"],
    ]) {
      assert.equal((await policy({ ref })).channel, channel);
      assert.equal((await policy({ ref })).should_publish, "true");
      assert.equal(
        (await policy({ ref, event: "workflow_dispatch" })).should_publish,
        "false",
      );
      assert.equal(
        (await policy({ ref, event: "workflow_dispatch", deploy: "true" }))
          .should_deploy,
        "true",
      );
    }
    // Both common annotated release tags and lightweight tags identify commits.
    for (const tag of ["v1.0.0", "v1.0.0-rc.1"]) {
      run([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "tag",
        "-a",
        "-f",
        tag,
        sha,
        "-m",
        "annotated fixture",
      ]);
      assert.equal(
        (await policy({ ref: `refs/tags/${tag}` })).should_deploy,
        "true",
      );
    }
    assert.equal(
      (
        await policy({
          event: "workflow_dispatch",
          ref: "refs/heads/feat/example",
        })
      ).should_publish,
      "false",
    );
    for (const ref of ["refs/heads/main", "refs/heads/feat/example"])
      await assert.rejects(
        policy({ event: "workflow_dispatch", ref, deploy: "true" }),
      );
    for (const ref of [
      "refs/heads/release/01.0.0",
      "refs/heads/release/1.0",
      "refs/tags/v01.0.0",
      "refs/tags/v1.0.0-rc.0",
      "refs/tags/v1.0.0-rc.01",
      "refs/tags/v1.0.0;echo bad",
      "refs/tags/v1.0.0\nshould_deploy=true",
      "refs/tags/v1.0.0-beta.1",
      "refs/tags/v1.0.0+meta",
      "refs/tags/v1.0.1",
      "refs/heads/release/1.0.1",
    ])
      await assert.rejects(policy({ ref }));
    await assert.rejects(
      policy({ ref: "refs/heads/release/1.0.0", deleted: "true" }),
    );
    await assert.rejects(policy({ sha: "a".repeat(40) }));
    run(["update-ref", "-d", "refs/tags/v1.0.0"]);
    await assert.rejects(policy({ ref: "refs/tags/v1.0.0" }));
    const later = run([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      sha,
      "-m",
      "later",
    ]);
    run(["update-ref", "refs/heads/release/1.0.0", later]);
    await assert.rejects(policy({ ref: "refs/heads/release/1.0.0" }), /Stale/);
    // A candidate commit outside accepted main cannot be a formal release.
    run(["update-ref", "HEAD", later]);
    run(["update-ref", "refs/heads/main", sha]);
    run(["update-ref", "refs/tags/v1.0.0", later]);
    // Detached checkout avoids updating main when moving HEAD.
    run(["update-ref", "--no-deref", "HEAD", later]);
    await assert.rejects(policy({ sha: later, ref: "refs/tags/v1.0.0" }));
    run(["update-ref", "refs/tags/v1.0.0-rc.1", later]);
    assert.equal(
      (await policy({ sha: later, ref: "refs/tags/v1.0.0-rc.1" })).channel,
      "rc",
    );
    run(["update-ref", "refs/heads/release/1.0.0", sha]);
    await assert.rejects(policy({ sha: later, ref: "refs/tags/v1.0.0-rc.1" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version helper synchronizes only application workspace versions", async () => {
  const { root } = await fixture();
  try {
    await setVersion("1.1.0", root);
    assert.equal(await applicationVersion(root), "1.1.0");
    assert.match(
      await readFile(join(root, "Cargo.toml"), "utf8"),
      /protocol 0\.1\.0/,
    );
    assert.match(
      await readFile(join(root, "Cargo.lock"), "utf8"),
      /name = "external"\nversion = "0.1.0"/,
    );
    await assert.rejects(setVersion("01.0.0", root));
    await assert.rejects(setVersion("1.1.0-rc.1", root));
    await writeFile(
      join(root, "package.json"),
      '{"private":true,"version":"1.2.0"}',
    );
    await assert.rejects(applicationVersion(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository application versions agree across private packages and Cargo", async () => {
  assert.match(
    await applicationVersion(),
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
});
