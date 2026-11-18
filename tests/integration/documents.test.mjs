import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { start, waitFor } from "../../scripts/processes.mjs";
import { docx, pdf } from "../fixtures/documents.mjs";
import { intakeSelectedFile } from "../../apps/desktop/src/file-intake.ts";
test(
  "real HTTP streaming, document utility formats, scoped desktop copy, SSE and reopen",
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scenesparrow-documents-"));
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    const token = randomUUID().replaceAll("-", "");
    const headers = {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const base = `http://127.0.0.1:${port}/v1`;
    let child;
    const launch = async () => {
      child = start(
        `./target/debug/scenesparrow-service${process.platform === "win32" ? ".exe" : ""}`,
        [],
        {
          env: {
            ...process.env,
            SCENESPARROW_SESSION_TOKEN: token,
            SCENESPARROW_CORE_PORT: String(port),
            SCENESPARROW_PROJECT_DIR: directory,
          },
        },
      );
      await waitFor(`${base}/health`, headers, child);
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGINT");
        await done;
      }
    };
    const request = async (path, body) => {
      const response = await fetch(base + path, {
        headers,
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    const upload = async (name, bytes) => {
      const response = await fetch(base + "/intakes", {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "content-type": "application/octet-stream",
          "x-intake-id": randomUUID(),
          "x-file-name": encodeURIComponent(name),
        },
        body: bytes,
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const waitJob = async (id) => {
      for (let i = 0; i < 400; i++) {
        const job = await request(`/document-jobs/${id}`);
        if (!["queued", "running"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("Document job timed out");
    };
    try {
      await launch();
      const { project } = await request("/project", {
        requestId: "documents",
        title: "Documents",
      });
      let revision = 0;
      const command = async (type, payload) => {
        const receipt = await request("/manuscript/commands", {
          type,
          requestId: randomUUID(),
          projectId: project.id,
          expectedWorkingRevision: revision,
          payload,
        });
        revision = receipt.workingRevision;
        return receipt;
      };
      const linkId = randomUUID();
      const exactUrl = "https://example.com/path%2Fpart?case=Exact#Hash";
      await command("AddSourceLink", {
        sourceId: linkId,
        url: exactUrl,
        title: "Original",
      });
      const rename = {
        type: "RenameSourceLink",
        requestId: randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: revision,
        payload: {
          sourceId: linkId,
          expectedSourceRevision: 1,
          title: "Renamed 中文",
        },
      };
      const renamedReceipt = await request("/manuscript/commands", rename);
      revision = renamedReceipt.workingRevision;
      assert.deepEqual(
        await request("/manuscript/commands", rename),
        renamedReceipt,
      );
      const source = (await request("/sources")).items.find(
        (item) => item.source.id === linkId,
      ).source;
      assert.equal(source.url, exactUrl);
      assert.equal(source.title, "Renamed 中文");
      assert.equal(source.revision, 2);
      const stale = await fetch(base + "/manuscript/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...rename,
          requestId: randomUUID(),
          expectedWorkingRevision: revision,
        }),
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "REVISION_CONFLICT");
      assert.equal(
        (await fetch(base + "/intakes", { method: "POST", body: "untrusted" }))
          .status,
        401,
      );
      assert.equal(
        (await fetch(base + "/project/events?token=" + token)).status,
        401,
      );
      async function* chunks() {
        for (let n = 0; n < 25; n++) yield Buffer.alloc(1024 * 1024);
        yield Buffer.alloc(1);
      }
      const oversizedId = randomUUID();
      const oversized = await fetch(base + "/intakes", {
        method: "POST",
        headers: {
          Authorization: headers.Authorization,
          "x-intake-id": oversizedId,
          "x-file-name": "oversized.txt",
        },
        body: chunks(),
        duplex: "half",
      });
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).code, "INPUT_TOO_LARGE");
      assert.equal(
        (await fetch(base + `/intakes/${oversizedId}`, { headers })).status,
        404,
      );
      const external = join(directory, "external.txt");
      await writeFile(external, "Original independent bytes");
      const desktop = await intakeSelectedFile(external, base, token);
      await writeFile(external, "External file changed");
      const sourceId = randomUUID();
      await command("AddSourceFile", {
        sourceId,
        intakeId: desktop.id,
        hash: desktop.hash,
      });
      assert.deepEqual((await request("/manuscript")).blocks, []);
      const extractId = randomUUID();
      await request("/document-jobs", {
        type: "extractSource",
        jobId: extractId,
        sourceId,
      });
      const extracted = await waitJob(extractId);
      assert.equal(extracted.status, "ready");
      assert.equal(extracted.result.text, "Original independent bytes");
      assert.equal(
        (await request(`/source-extractions/${extractId}`)).text,
        "Original independent bytes",
      );
      const fixtures = [
        ["valid.txt", Buffer.from("First\n\nSecond"), null],
        [
          "utf16.txt",
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from("中文 🐦", "utf16le"),
          ]),
          null,
        ],
        ["valid.md", Buffer.from("# Heading\n\n**Bold** text"), null],
        [
          "valid.docx",
          docx(
            '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX semantic heading</w:t></w:r></w:p>',
          ),
          null,
        ],
        [
          "valid.pdf",
          pdf([{ text: "PDF page one" }, { text: "PDF page two" }]),
          null,
        ],
        ["mixed.pdf", pdf([{ text: "Text page" }, { image: true }]), null],
        ["scan.pdf", pdf([{ image: true }]), "SOURCE_TEXT_UNAVAILABLE"],
        ["encrypted.pdf", pdf([{ text: "Secret" }], true), "SOURCE_ENCRYPTED"],
        ["corrupt.docx", Buffer.from("corrupt"), "DOCUMENT_PARSE_FAILED"],
        ["corrupt.pdf", Buffer.from("corrupt"), "DOCUMENT_PARSE_FAILED"],
        ["empty.txt", Buffer.alloc(0), "SOURCE_TEXT_UNAVAILABLE"],
        ["encoding.txt", Buffer.from([0xff]), "TEXT_ENCODING_UNSUPPORTED"],
        ["controls.txt", Buffer.from("unsafe\0control"), "DOCUMENT_INVALID"],
      ];
      let candidate;
      for (const [name, bytes, error] of fixtures) {
        const input = await upload(name, bytes);
        const jobId = randomUUID();
        await request("/document-jobs", {
          type: "prepareFile",
          jobId,
          intakeId: input.id,
          expectedWorkingRevision: revision,
        });
        const job = await waitJob(jobId);
        if (error) assert.equal(job.error, error, name);
        else {
          assert.equal(job.status, "ready", name);
          assert.ok(job.candidateHash);
          candidate ??= job;
        }
        assert.equal((await request("/manuscript")).workingRevision, revision);
      }
      const escapedId = randomUUID();
      await request("/document-jobs", {
        type: "preparePaste",
        jobId: escapedId,
        text: Array.from({ length: 1000 }, () => "\\".repeat(1600)).join(
          "\n\n",
        ),
        expectedWorkingRevision: revision,
      });
      assert.equal(
        (await waitJob(escapedId)).status,
        "ready",
        "valid escaped paste exceeds the small JSON envelope but remains within canonical limits",
      );
      const commit = {
        type: "CommitManuscriptImport",
        requestId: randomUUID(),
        projectId: project.id,
        expectedWorkingRevision: revision,
        payload: {
          preparedId: candidate.id,
          candidateHash: candidate.candidateHash,
          mode: "start",
        },
      };
      const receipt = await request("/manuscript/commands", commit);
      revision = receipt.workingRevision;
      assert.deepEqual(await request("/manuscript/commands", commit), receipt);
      const manuscript = await request("/manuscript");
      assert.equal(manuscript.blocks.length, 2);
      const streamAbort = new AbortController();
      const stream = await fetch(base + "/project/events?after=0", {
        headers: { Authorization: headers.Authorization },
        signal: streamAbort.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type"), /text\/event-stream/);
      const reader = stream.body.getReader();
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.match(frame, /event: project/);
      streamAbort.abort();
      await reader.cancel().catch(() => {});
      const history = await request("/history");
      await stop();
      await launch();
      assert.deepEqual(await request("/manuscript"), manuscript);
      assert.deepEqual(await request("/history"), history);
      assert.deepEqual(await request(`/commands/${commit.requestId}`), receipt);
      assert.equal(
        (await request("/sources")).items.find(
          (item) => item.source.id === sourceId,
        ).status,
        "ready",
      );
      assert.equal((await request(`/document-jobs/${extractId}`)).attempt, 1);
      assert.equal(
        (await request(`/document-jobs/${extractId}`)).status,
        "ready",
      );
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
