import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateOrigin } from "./gateway.mjs";

import { operatorConfiguration } from "./operator-config.mjs";

const env = process.env;
const host = env.DEPLOY_HOST;
const user = env.DEPLOY_USER;
const port = env.DEPLOY_SSH_PORT || "22";
const directory = env.DEPLOY_DIR || "/srv/scenesparrow";
const origin = env.PUBLIC_ORIGIN || "https://scene.mindreview.me";
// Reject incomplete credentials before opening an SSH connection.
const operatorAuth = operatorConfiguration(env);
validateOrigin(origin);
if (
  !/^[A-Za-z0-9.-]+$/.test(host ?? "") ||
  host.startsWith("-") ||
  !/^[A-Za-z0-9_-]+$/.test(user ?? "") ||
  !/^\d{1,5}$/.test(port) ||
  +port < 1 ||
  +port > 65535 ||
  !/^\/[A-Za-z0-9_/-]+$/.test(directory) ||
  directory.split("/").includes("..") ||
  !/^[a-z0-9][a-z0-9_./-]*$/.test(env.IMAGE_NAME ?? "") ||
  !/^sha256:[a-f0-9]{64}$/.test(env.IMAGE_DIGEST ?? "") ||
  !env.DEPLOY_SSH_KEY ||
  !env.DEPLOY_KNOWN_HOSTS ||
  !env.GHCR_TOKEN
)
  throw Error("Invalid deployment configuration");
const webPort = Number(env.WEB_PORT || 8070);
if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
  throw Error("Invalid web port");
const temporary = await mkdtemp(join(tmpdir(), "scenesparrow-client-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw Error(`${command} failed`);
  return result.stdout?.trim();
};
try {
  const key = join(temporary, "key");
  const known = join(temporary, "known_hosts");
  await writeFile(key, env.DEPLOY_SSH_KEY, { mode: 0o600 });
  await writeFile(known, env.DEPLOY_KNOWN_HOSTS, { mode: 0o600 });
  const options = [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${known}`,
    "-o",
    "ConnectTimeout=15",
  ];
  const destination = `${user}@${host}`;
  const incoming = run(
    "ssh",
    [
      ...options,
      "-p",
      port,
      destination,
      "umask 077; mktemp -d /tmp/scenesparrow-deploy.XXXXXXXX",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  if (!/^\/tmp\/scenesparrow-deploy\.[A-Za-z0-9]+$/.test(incoming))
    throw Error("Invalid remote temporary path");
  await writeFile(
    join(temporary, "config.json"),
    JSON.stringify({
      image: `${env.IMAGE_NAME}@${env.IMAGE_DIGEST}`,
      origin,
      directory,
      port: webPort,
      actor: env.GHCR_ACTOR,
    }),
    { mode: 0o600 },
  );
  const files = [
    "deploy/compose.yaml",
    "deploy/deploy.sh",
    join(temporary, "config.json"),
  ];
  if (operatorAuth) {
    const secret = join(temporary, "operator-auth");
    await writeFile(secret, operatorAuth, { mode: 0o600 });
    files.push(secret);
  }
  try {
    run(
      "scp",
      [...options, "-P", port, ...files, `${destination}:${incoming}/`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    run(
      "ssh",
      [
        ...options,
        "-p",
        port,
        destination,
        `bash ${incoming}/deploy.sh ${incoming}`,
      ],
      { input: env.GHCR_TOKEN, stdio: ["pipe", "inherit", "inherit"] },
    );
  } finally {
    run("ssh", [...options, "-p", port, destination, `rm -rf -- ${incoming}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
} finally {
  await chmod(temporary, 0o700);
  await rm(temporary, { recursive: true, force: true });
}
