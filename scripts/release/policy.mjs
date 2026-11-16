import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationVersion, stableVersion } from "./version.mjs";

// All Git arguments are separate argv entries. Ref strings never become shell code.
export function git(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw Error("Release history verification failed");
  return result.stdout.trim();
}
export async function releasePolicy(
  { event, ref, sha, deploy = "false", deleted = "false" },
  { root = process.cwd(), run = (args) => git(args, root) } = {},
) {
  if (
    !["push", "workflow_dispatch"].includes(event) ||
    !["true", "false"].includes(deploy) ||
    deleted !== "false" ||
    !/^[a-f0-9]{40}$/.test(sha ?? "")
  )
    throw Error("Invalid release event");
  const version = await applicationVersion(root);
  if (run(["rev-parse", "HEAD"]) !== sha)
    throw Error("Checkout differs from tested event commit");
  let channel = "checks";
  let expected;
  let branch;
  if (ref === "refs/heads/main") channel = "main";
  else if (ref?.startsWith("refs/heads/release/")) {
    expected = ref.slice("refs/heads/release/".length);
    if (!stableVersion.test(expected)) throw Error("Invalid release branch");
    channel = "candidate";
    branch = `release/${expected}`;
  } else if (ref?.startsWith("refs/tags/")) {
    const match =
      /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-rc\.([1-9]\d*))?$/.exec(
        ref,
      );
    if (!match) throw Error("Invalid version tag");
    expected = match[1];
    channel = match[2] ? "rc" : "stable";
    branch = match[2] ? `release/${expected}` : "main";
  } else if (
    event !== "workflow_dispatch" ||
    !/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(ref ?? "") ||
    ref.includes("..")
  )
    throw Error("Unsupported ref");
  if (expected && expected !== version)
    throw Error("Application version does not match release ref");
  const eligible = ["candidate", "rc", "stable"].includes(channel);
  if (deploy === "true" && !eligible)
    throw Error("Explicit deployment requires a release branch or version tag");
  // Refresh exact source refs even for build-only manual runs on version refs.
  const refresh = (source, target) =>
    run(["fetch", "--no-tags", "--force", "origin", `+${source}:${target}`]);
  if (eligible) {
    refresh(ref, "refs/scenesparrow/event");
    if (run(["rev-parse", "refs/scenesparrow/event^{commit}"]) !== sha)
      throw Error("Stale or moved release ref");
    if (channel !== "candidate") {
      refresh(`refs/heads/${branch}`, "refs/scenesparrow/baseline");
      run(["merge-base", "--is-ancestor", sha, "refs/scenesparrow/baseline"]);
    }
  }
  const publish = eligible && (event === "push" || deploy === "true");
  return {
    channel,
    ref,
    version,
    should_publish: String(publish),
    should_deploy: String(publish),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await releasePolicy({
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    deploy: process.env.REQUEST_DEPLOY || "false",
    deleted: process.env.EVENT_DELETED || "false",
  });
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(JSON.stringify(result));
}
