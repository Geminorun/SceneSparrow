import test from "node:test";
import { zip, zipEntries } from "../fixtures/documents.mjs";
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
    // MOR-AC01: fixed documents use independent exact-byte revisions and CAS.
    const outlinePath = `/markdown-projects/${p.projectId}/documents/outline`;
    assert.deepEqual(await (await send(outlinePath)).json(), {
      projectId: p.projectId,
      kind: "outline",
      text: "",
      revision: null,
    });
    const outlineText = "\ufeff# Outline 中文\r\n\r\n* Exact bytes\r\n";
    const outline = await (
      await send(outlinePath, { revision: null, text: outlineText })
    ).json();
    assert.match(outline.revision, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(dir, "outline.md"), "utf8"), outlineText);
    assert.deepEqual(
      await (await send(`/markdown-projects/${p.projectId}`)).json(),
      p,
    );
    assert.equal(
      (await send(outlinePath, { revision: null, text: "stale" })).status,
      409,
    );
    assert.equal(
      (
        await send(outlinePath, {
          revision: outline.revision,
          text: "x".repeat(256 * 1024 + 1),
        })
      ).status,
      422,
    );
    const concurrent = await Promise.all([
      send(outlinePath, { revision: outline.revision, text: "First" }),
      send(outlinePath, { revision: outline.revision, text: "Second" }),
    ]);
    assert.deepEqual(concurrent.map((v) => v.status).sort(), [200, 409]);
    const currentOutline = await (await send(outlinePath)).json();
    const empty = await (
      await send(outlinePath, { revision: currentOutline.revision, text: "" })
    ).json();
    assert.match(empty.revision, /^[a-f0-9]{64}$/);
    assert.notEqual(empty.revision, null);
    // A damaged other document cannot stop independent read/save.
    await writeFile(join(dir, "manuscript.md"), Buffer.from([255]));
    assert.equal((await send(outlinePath)).status, 200);
    assert.equal(
      (
        await send(outlinePath, {
          revision: empty.revision,
          text: "Independent",
        })
      ).status,
      200,
    );
    await writeFile(join(dir, "manuscript.md"), text);
    await writeFile(join(dir, "outline.md"), Buffer.from([255]));
    assert.equal((await send(`/markdown-projects/${p.projectId}`)).status, 200);
    assert.equal((await send(outlinePath)).status, 422);
    await writeFile(join(dir, "outline.md"), "Independent");
    // WFW-AC05–06: ZIP review is read-only; application uses the same revision-checked save.
    const exchangePath = `/markdown-projects/${p.projectId}/exchange`;
    const exportedOutline = await (await send(outlinePath)).json();
    const exported = await send(
      `${exchangePath}?revision=${p.revision}&outlineRevision=${exportedOutline.revision}`,
    );
    assert.equal(exported.headers.get("content-type"), "application/zip");
    const entries = zipEntries(Buffer.from(await exported.arrayBuffer()));
    assert.deepEqual(Object.keys(entries).sort(), [
      "exchange.json",
      "project/manuscript.md",
      "project/outline.md",
      "project/project.json",
    ]);
    assert.equal(JSON.parse(entries["exchange.json"]).baseRevision, p.revision);
    assert.deepEqual(entries["project/manuscript.md"], Buffer.from(text));
    const review = (bytes) =>
      fetch(url + exchangePath, {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "content-type": "application/zip",
        },
        body: bytes,
      });
    assert.equal(
      (await review(Buffer.alloc(10 * 1024 * 1024 + 256 * 1024 + 65536 + 1)))
        .status,
      422,
    );
    const unchanged = await (await review(zip(entries))).json();
    assert.deepEqual(unchanged.documents, []);
    assert.equal(
      JSON.parse(entries["exchange.json"]).outlineBaseRevision,
      exportedOutline.revision,
    );
    assert.equal(
      entries["project/outline.md"].toString(),
      exportedOutline.text,
    );
    const returnedText = "\ufeff# Returned 中文\r\nlast\rline\n";
    entries["project/manuscript.md"] = Buffer.from(returnedText);
    const reviewed = (
      await (await review(zip({ "project/": "", ...entries }))).json()
    ).documents[0];
    assert.equal(reviewed.text, returnedText);
    assert.equal(reviewed.currentRevision, p.revision);
    assert.equal(await readFile(join(dir, "manuscript.md"), "utf8"), text);
    for (const invalid of [
      Buffer.from("not a ZIP"),
      zip({ ...entries, "../outside": "bad" }),
      zip({ ...entries, "project/manuscript.md": Buffer.from([255]) }),
      zip({ ...entries, "exchange.json": '{"baseRevision":"bad"}' }),
      zip([...Object.entries(entries), ["project/manuscript.md", "duplicate"]]),
      zip({
        ...entries,
        "project/manuscript.md": "x".repeat(2 * 1024 * 1024 + 1),
      }),
    ]) {
      const response = await review(invalid);
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "MARKDOWN_EXCHANGE_INVALID");
    }
    const symlink = zip(entries);
    let central = symlink.readUInt32LE(symlink.length - 22 + 16);
    symlink[central + 5] = 3; // UNIX origin makes the external mode authoritative.
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    assert.equal(
      (await (await review(symlink)).json()).code,
      "MARKDOWN_EXCHANGE_INVALID",
    );
    const wrong = {
      ...entries,
      "project/project.json": JSON.stringify({
        ...JSON.parse(entries["project/project.json"]),
        projectId: "00000000-0000-4000-8000-000000000000",
      }),
    };
    assert.equal(
      (await (await review(zip(wrong))).json()).code,
      "MARKDOWN_EXCHANGE_PROJECT_MISMATCH",
    );
    assert.equal(await readFile(join(dir, "manuscript.md"), "utf8"), text);
    const accepted = await (
      await send(`/markdown-projects/${p.projectId}`, {
        text: reviewed.text,
        revision: reviewed.baseRevision,
      })
    ).json();
    assert.equal(accepted.projectId, p.projectId);
    assert.equal(
      await readFile(join(dir, "manuscript.md"), "utf8"),
      returnedText,
    );
    assert.equal(
      (
        await send(
          `${exchangePath}?revision=${p.revision}&outlineRevision=${exportedOutline.revision}`,
        )
      ).status,
      409,
    );
    const conflicted = (await (await review(zip(entries))).json()).documents[0];
    assert.equal(conflicted.currentRevision, accepted.revision);
    assert.equal(conflicted.baseRevision, p.revision);
    assert.equal(
      (
        await send(`/markdown-projects/${p.projectId}`, {
          text: "cannot overwrite",
          revision: conflicted.baseRevision,
        })
      ).status,
      409,
    );
    const forked = await (
      await send("/markdown-projects", { text: reviewed.text })
    ).json();
    assert.notEqual(forked.projectId, p.projectId);
    assert.equal(forked.text, returnedText);
    // MOR-AC07–09: document review is independent; returned sidecars never authorize a write.
    const handoff = await (
      await send("/markdown-projects", { text: "Protected manuscript" })
    ).json();
    const handoffPath = `/markdown-projects/${handoff.projectId}`;
    const handoffDir = join(root, handoff.projectId);
    const plan = await (
      await send(`${handoffPath}/documents/outline`, {
        revision: null,
        text: "\ufeff# Outline 中文\r\n",
      })
    ).json();
    const lockManuscript = () =>
      send(`${handoffPath}/documents/manuscript/annotations`, {
        action: "lock",
        revision: handoff.revision,
        ranges: [{ start: 0, end: Buffer.byteLength(handoff.text) }],
      });
    const lockResponse = await lockManuscript();
    assert.equal(lockResponse.status, 200);
    const locksBefore = await readFile(join(handoffDir, "locks.json"));
    const commentsBefore = Buffer.from('{ "comments": [] }\n');
    await writeFile(join(handoffDir, "comments.json"), commentsBefore);
    const manifestBefore = await readFile(join(handoffDir, "project.json"));
    const handoffEntries = zipEntries(
      Buffer.from(
        await (
          await send(
            `${handoffPath}/exchange?revision=${handoff.revision}&outlineRevision=${plan.revision}`,
          )
        ).arrayBuffer(),
      ),
    );
    assert.deepEqual(handoffEntries["project/locks.json"], locksBefore);
    assert.deepEqual(handoffEntries["project/comments.json"], commentsBefore);
    assert.deepEqual(handoffEntries["project/project.json"], manifestBefore);
    assert.equal(handoffEntries["project/outline.md"].toString(), plan.text);
    const returnFor = (path, entries) =>
      fetch(url + path + "/exchange", {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "content-type": "application/zip",
        },
        body: zip(entries),
      });
    const both = {
      ...handoffEntries,
      "project/manuscript.md": "Agent manuscript",
      "project/outline.md": "",
      "project/locks.json": '{"locks":[]}',
      "project/comments.json": '{"comments":["untrusted"]}',
    };
    const bothReview = await (await returnFor(handoffPath, both)).json();
    assert.deepEqual(
      bothReview.documents.map((v) => [v.kind, v.conflict]),
      [
        ["manuscript", "MARKDOWN_LOCKED"],
        ["outline", null],
      ],
    );
    const cleared = await (
      await send(`${handoffPath}/documents/outline`, {
        revision: plan.revision,
        text: bothReview.documents[1].text,
      })
    ).json();
    assert.equal(cleared.text, "");
    assert.match(cleared.revision, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await send(`${handoffPath}/documents/manuscript`, {
          revision: handoff.revision,
          text: bothReview.documents[0].text,
        })
      ).status,
      422,
    );
    assert.deepEqual(
      await readFile(join(handoffDir, "locks.json")),
      locksBefore,
    );
    assert.deepEqual(
      await readFile(join(handoffDir, "comments.json")),
      commentsBefore,
    );
    // An unchanged manuscript is not inspected, even when its live file is unreadable.
    await writeFile(join(handoffDir, "manuscript.md"), Buffer.from([255]));
    const onlyOutline = await (
      await returnFor(handoffPath, {
        ...handoffEntries,
        "project/outline.md": "Agent outline",
      })
    ).json();
    assert.deepEqual(
      onlyOutline.documents.map((v) => [v.kind, v.conflict]),
      [["outline", "MARKDOWN_CONFLICT"]],
    );
    await writeFile(join(handoffDir, "manuscript.md"), handoff.text);
    // Old archives retain the current outline; an added live lock still blocks save after preview.
    const lockId = (
      await (
        await send(`${handoffPath}/documents/manuscript/annotations`)
      ).json()
    ).locks[0].id;
    await send(`${handoffPath}/documents/manuscript/annotations`, {
      action: "unlock",
      id: lockId,
    });
    const old = {
      "exchange.json": JSON.stringify({ baseRevision: handoff.revision }),
      "project/project.json": handoffEntries["project/project.json"],
      "project/manuscript.md": "Legacy return",
    };
    const oldReview = await (await returnFor(handoffPath, old)).json();
    assert.deepEqual(
      oldReview.documents.map((v) => [v.kind, v.conflict]),
      [["manuscript", null]],
    );
    assert.equal((await lockManuscript()).status, 200);
    assert.equal(
      (
        await send(`${handoffPath}/documents/manuscript`, {
          revision: handoff.revision,
          text: oldReview.documents[0].text,
        })
      ).status,
      422,
    );
    assert.equal(
      (await (await send(`${handoffPath}/documents/outline`)).json()).revision,
      cleared.revision,
    );
    assert.equal(
      (
        await returnFor(handoffPath, {
          ...old,
          "project/outline.md": "must not broaden legacy scope",
        })
      ).status,
      422,
    );
    const withoutOutline = { ...handoffEntries };
    delete withoutOutline["project/outline.md"];
    assert.equal((await returnFor(handoffPath, withoutOutline)).status, 422);
    assert.equal(
      (
        await returnFor(handoffPath, {
          ...handoffEntries,
          "project/comments.json": Buffer.alloc(4 * 1024 * 1024),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await returnFor(handoffPath, {
          ...handoffEntries,
          "project/comments.json": Buffer.alloc(4 * 1024 * 1024 + 1),
        })
      ).status,
      422,
    );
    const absent = await (
      await send("/markdown-projects", { text: "No outline yet" })
    ).json();
    const absentPath = `/markdown-projects/${absent.projectId}`;
    const absentEntries = zipEntries(
      Buffer.from(
        await (
          await send(
            `${absentPath}/exchange?revision=${absent.revision}&outlineRevision=absent`,
          )
        ).arrayBuffer(),
      ),
    );
    assert.equal(
      JSON.parse(absentEntries["exchange.json"]).outlineBaseRevision,
      null,
    );
    assert.equal(absentEntries["project/outline.md"], undefined);
    await assert.rejects(access(join(root, absent.projectId, "outline.md")));
    const added = await (
      await returnFor(absentPath, {
        ...absentEntries,
        "project/outline.md": "",
      })
    ).json();
    assert.deepEqual(
      added.documents.map((v) => [v.kind, v.baseRevision, v.conflict]),
      [["outline", null, null]],
    );
    const explicitEmpty = await (
      await send(`${absentPath}/documents/outline`, {
        revision: null,
        text: added.documents[0].text,
      })
    ).json();
    assert.match(explicitEmpty.revision, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await send(
          `${absentPath}/exchange?revision=${absent.revision}&outlineRevision=absent`,
        )
      ).status,
      409,
    );
    // Restore the initial snapshot for the original stale-write checks below.
    await send(`/markdown-projects/${p.projectId}`, {
      text,
      revision: accepted.revision,
    });
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
