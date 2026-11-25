import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "EWA-AC07 isolated launcher rejects shared paths and unsafe auth before Docker starts",
  { skip: process.platform !== "linux" },
  async () => {
    for (const mode of [
      "public-directory",
      "project-in-socket",
      "operator-config",
      "symlink",
      "fifo",
    ]) {
      const root = await mkdtemp(join(tmpdir(), "ewa-launcher-test-"));
      const socket = join(root, "socket"),
        auth = join(root, "auth");
      try {
        await mkdir(socket, { mode: 0o700 });
        await mkdir(auth, { mode: 0o700 });
        if (mode === "public-directory") await chmod(socket, 0o755);
        if (mode === "project-in-socket")
          await writeFile(
            join(socket, "PRIVATE_PROJECT.md"),
            "must not be mounted",
          );
        if (mode === "operator-config")
          await writeFile(join(auth, "config.toml"), "must not be loaded");
        if (mode === "symlink")
          await symlink(join(root, "outside-auth"), join(auth, "auth.json"));
        if (mode === "fifo")
          assert.equal(
            spawnSync("mkfifo", [join(auth, "auth.json")]).status,
            0,
          );
        const result = spawnSync(
          "bash",
          [
            new URL(
              "../../scripts/agent/run-codex-isolated.sh",
              import.meta.url,
            ).pathname,
            socket,
            auth,
            "/bin/true",
          ],
          { encoding: "utf8", timeout: 2000 },
        );
        assert.equal(result.status, 2, mode);
        assert(
          !result.stderr.includes(root),
          "private paths stay out of diagnostics",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
