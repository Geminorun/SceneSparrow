import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer, request } from "node:http";
import {
  createGateway,
  readOperator,
  validateOrigin,
} from "../../scripts/web/gateway.mjs";

test("production gateway authenticates all content, enforces origin, strips secrets and cancels SSE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scenesparrow-gateway-"));
  const credential = "operator:" + "r".repeat(16);
  const origin = "https://scene.example";
  let received;
  let receivedPath;
  let streamClosed = false;
  const core = createServer((req, res) => {
    received = req.headers;
    receivedPath = req.url;
    if (req.url === "/v1/oversized") {
      res.writeHead(200, { "content-length": 33 * 1024 * 1024 });
      res.end("oversized");
      return;
    }
    if (req.url === "/v1/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: ready\n\n");
      req.on("close", () => {
        streamClosed = true;
      });
    } else {
      req.resume();
      req.on("end", () => {
        res.end("core");
      });
    }
  });
  let gateway;
  try {
    await writeFile(join(directory, "auth"), credential);
    await writeFile(join(directory, "index.html"), "built frontend");
    await symlink("/etc/passwd", join(directory, "outside"));
    await assert.rejects(readOperator(join(directory, "index.html")));
    assert.throws(() => validateOrigin("http://scene.example"));
    assert.throws(() => validateOrigin("https://scene.example/"));
    core.listen(0, "127.0.0.1");
    await once(core, "listening");
    gateway = await createGateway({
      origin,
      operator: await readOperator(join(directory, "auth")),
      staticRoot: directory,
      corePort: core.address().port,
      token: "private-core-token",
    });
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const send = (path, { method = "GET", headers = {}, body } = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: gateway.server.address().port,
            path,
            method,
            headers: {
              host: "scene.example",
              authorization: `Basic ${Buffer.from(credential).toString("base64")}`,
              ...headers,
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString(),
                headers: res.headers,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    for (const path of ["/", "/api/v1/project"]) {
      assert.equal(
        (await send(path, { headers: { authorization: "" } })).status,
        401,
      );
      assert.equal(
        (await send(path, { headers: { authorization: "Basic wrong" } }))
          .status,
        401,
      );
    }
    assert.equal((await send("/")).body, "built frontend");
    const navigation = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    assert.equal((await send("/", { headers: navigation })).status, 200);
    assert.equal(
      (await send("/api/v1/project", { headers: navigation })).status,
      403,
    );
    assert.equal(
      (
        await send("/api/v1/project", {
          method: "POST",
          headers: { ...navigation, origin },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await send("/outside")).status, 404);
    for (const path of [
      "/../etc/passwd",
      "/%2e%2e/etc/passwd",
      "/%2fetc/passwd",
      "/api/v1/project/%2e%2e/quiesce",
    ])
      assert.equal((await send(path)).status, 400);
    for (const path of [
      "/api/v1/project/quiesce",
      "/api/v1/project/backup",
      "/api/v1/manuscript/deliveries/test",
    ])
      assert.equal((await send(path)).status, 403);
    assert.equal(
      (await send("/api/v1/project", { method: "POST", body: "{}" })).status,
      403,
    );
    assert.equal(
      (
        await send("/api/v1/project", {
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await send("/", { headers: { host: "evil.example" } })).status,
      403,
    );
    assert.equal(
      (
        await send("/api/v1/project", {
          method: "POST",
          headers: {
            origin,
            "x-scenesparrow-native": "leak",
            cookie: "secret",
            "x-intake-id": "allowed",
          },
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(received.authorization, "Bearer private-core-token");
    assert.equal(received.origin, origin);
    assert.equal(received["x-scenesparrow-native"], undefined);
    assert.equal(received.cookie, undefined);
    assert.equal(received["x-intake-id"], "allowed");
    assert.equal((await send("/api/v1/project?q=one?two%20three")).status, 200);
    assert.equal(receivedPath, "/v1/project?q=one?two%20three");
    assert.equal((await send("/api/v1/oversized")).status, 502);
    assert.equal(
      (
        await send("/api/v1/project", {
          method: "POST",
          headers: { origin, "content-length": String(25 * 1024 * 1024 + 1) },
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await send("/api/v1/project", {
          method: "POST",
          headers: { origin, "transfer-encoding": "chunked" },
          body: Buffer.alloc(25 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
    const openStream = () =>
      new Promise((resolve) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: gateway.server.address().port,
            path: "/api/v1/events",
            headers: {
              host: "scene.example",
              authorization: `Basic ${Buffer.from(credential).toString("base64")}`,
            },
          },
          (res) => {
            res.once("data", (chunk) => resolve({ req, res, chunk }));
            res.on("error", () => {});
          },
        );
        req.on("error", () => {});
        req.end();
      });
    const response = await openStream();
    assert.match(response.chunk.toString(), /data: ready/);
    response.req.destroy();
    for (let n = 0; n < 50 && !streamClosed; n++)
      await new Promise((done) => setTimeout(done, 10));
    assert.equal(streamClosed, true);
    // Shutdown must finish even with another live event connection.
    await openStream();
    await gateway.close();
  } finally {
    await gateway?.close();
    core.closeAllConnections();
    await new Promise((done) => core.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
