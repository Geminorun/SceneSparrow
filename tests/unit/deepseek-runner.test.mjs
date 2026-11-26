import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import {
  credentialHandshake,
  admit,
  encode,
} from "../../scripts/agent/deepseek/policy.mjs";
import { providerProxy } from "../../scripts/agent/deepseek/relay.mjs";

test("DSH-AC02 private handshake and text-only ACP admission reject capability expansion", () => {
  assert.equal(credentialHandshake({ protocolVersion: 1, apiKey: null }), null);
  assert.equal(
    credentialHandshake({ protocolVersion: 1, apiKey: 'synthetic-"key\\' }),
    'synthetic-"key\\',
  );
  for (const message of [
    { protocolVersion: 2, apiKey: null },
    { protocolVersion: 1, apiKey: "line\nbreak" },
    { protocolVersion: 1, apiKey: "key", baseURL: "https://evil.test" },
    { protocolVersion: 1 },
  ])
    assert.throws(() => credentialHandshake(message));
  const rpc = (method, params) => ({ jsonrpc: "2.0", method, params });
  assert(admit(rpc("session/new", { cwd: "/tmp/writing", mcpServers: [] })));
  assert(
    admit(rpc("session/prompt", { prompt: [{ type: "text", text: "write" }] })),
  );
  assert(!admit(rpc("session/new", { cwd: "/workspace", mcpServers: [] })));
  assert(
    !admit(
      rpc("session/new", {
        cwd: "/tmp/writing",
        mcpServers: [{ command: "sh" }],
      }),
    ),
  );
  assert(
    !admit(
      rpc("session/prompt", {
        prompt: [{ type: "resource_link", uri: "file:///secret" }],
      }),
    ),
  );
  assert(
    !admit(
      rpc("session/set_config_option", { configId: "tools", value: "shell" }),
    ),
  );
  assert(!admit(rpc("session/resume", {})));
  const key = 'synthetic-"key\\';
  const safe = encode({ error: { message: `denied ${key}` } }, key);
  assert.equal(JSON.parse(safe).error.message, "denied [REDACTED]");
});

test("DSH-AC02 fixed provider relay denies alternate paths and methods without connecting", async () => {
  let connects = 0;
  const server = providerProxy(() => {
    connects++;
    throw Error("must not connect");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [method, path] of [
      ["GET", "/anthropic/v1/messages"],
      ["POST", "/v1/responses"],
      ["POST", "https://evil.test/anthropic/v1/messages"],
      ["POST", "/anthropic/v1/messages?redirect=evil"],
    ]) {
      const status = await new Promise((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: server.address().port, method, path },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    }
    assert.equal(connects, 0);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test(
  "DSH-AC02 launcher rejects shared directories and extra mounted inputs before Docker",
  { skip: process.platform !== "linux" },
  async () => {
    for (const mode of ["public", "project", "symlink"]) {
      const root = await mkdtemp("/tmp/dsh-launcher-test-");
      const socket = `${root}/socket`;
      try {
        await mkdir(socket, { mode: 0o700 });
        if (mode === "public") await chmod(socket, 0o755);
        if (mode === "project")
          await writeFile(`${socket}/private.md`, "PRIVATE");
        if (mode === "symlink") await symlink(socket, `${root}/link`);
        const result = spawnSync(
          "bash",
          [
            new URL(
              "../../scripts/agent/run-deepseek-isolated.sh",
              import.meta.url,
            ).pathname,
            mode === "symlink" ? `${root}/link` : socket,
          ],
          { encoding: "utf8", timeout: 2000 },
        );
        assert.equal(result.status, 2, mode);
        assert(
          !result.stderr.includes(root),
          "private paths excluded from diagnostics",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
