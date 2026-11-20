import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { start, waitFor } from "../../scripts/processes.mjs";

test("MFP-AC01–05: real file core authenticates, saves exact bytes, rejects stale and invalid writes without SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-markdown-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const token = randomBytes(32).toString("hex");
  const headers = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const url = `http://127.0.0.1:${port}/v1`;
  const root = join(directory, "files");
  const legacy = join(directory, "unused-sql-project");
  const child = start(
    process.env.SCENESPARROW_CORE_BIN ??
      `./target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
    [],
    {
      env: {
        ...process.env,
        SCENESPARROW_SESSION_TOKEN: token,
        SCENESPARROW_CORE_PORT: String(port),
        SCENESPARROW_MARKDOWN_PROJECTS_DIR: root,
        SCENESPARROW_PROJECT_DIR: legacy,
      },
      stdio: "ignore",
    },
  );
  const send = (path, body, extra = {}) =>
    fetch(url + path, {
      method: body ? "POST" : "GET",
      headers: { ...headers, ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    await waitFor(`${url}/health`, headers, child);
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal(
      (await send("/health", undefined, { origin: "http://evil.example" }))
        .status,
      403,
    );
    assert.equal((await (await send("/health")).json()).markdownProjects, true);
    assert.equal((await send("/project")).status, 404);
    const text =
      "\ufeff# 中文\r\n<!-- comment -->\rlast\n[link](../never-read)";
    const p = await (await send("/markdown-projects", { text })).json();
    const dir = join(root, p.projectId);
    assert.deepEqual((await readdir(dir)).sort(), [
      "manuscript.md",
      "project.json",
    ]);
    assert.deepEqual(
      await readFile(join(dir, "manuscript.md")),
      Buffer.from(text),
    );
    assert.deepEqual(JSON.parse(await readFile(join(dir, "project.json"))), {
      format: "scenesparrow",
      formatVersion: 1,
      projectId: p.projectId,
      manuscript: "manuscript.md",
    });
    assert.deepEqual(
      await (await send(`/markdown-projects/${p.projectId}`)).json(),
      p,
    );
    const external = "externally changed\r\n";
    await writeFile(join(dir, "manuscript.md"), external);
    const stale = await send(`/markdown-projects/${p.projectId}`, {
      text: "local retained",
      revision: p.revision,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "MARKDOWN_CONFLICT");
    assert.equal(await readFile(join(dir, "manuscript.md"), "utf8"), external);
    // Legitimate worst-case escaped UTF-8 text must pass both JSON and text budgets.
    const largest = "\x00".repeat(2 * 1024 * 1024);
    const large = await send("/markdown-projects", { text: largest });
    assert.equal(large.status, 200);
    const largeProject = await large.json();
    assert.equal(largeProject.text, largest);
    assert.equal(
      (await send("/markdown-projects", { text: largest + "x" })).status,
      422,
    );
    assert.equal(
      (await send(`/markdown-projects/${p.projectId.toUpperCase()}`)).status,
      422,
    );
    await writeFile(
      join(dir, "project.json"),
      JSON.stringify({
        format: "scenesparrow",
        formatVersion: 1,
        projectId: p.projectId,
        manuscript: "../elsewhere",
      }),
    );
    assert.equal((await send(`/markdown-projects/${p.projectId}`)).status, 422);
    assert.equal(await readFile(join(dir, "manuscript.md"), "utf8"), external);
    await assert.rejects(access(legacy));
    assert.deepEqual((await readdir(directory)).sort(), ["files"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGINT");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
