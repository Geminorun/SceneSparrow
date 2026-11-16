import { createServer, request as httpRequest } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { open, realpath, readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pipeline } from "node:stream/promises";

const UPLOAD_LIMIT = 25 * 1024 * 1024;
const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest();
export function validateOperator(value) {
  if (!/^[A-Za-z0-9_-]{1,64}:[\x21-\x7e]{6,256}$/.test(value))
    throw Error("Invalid operator configuration");
  return value;
}
export async function readOperator(path) {
  const value = validateOperator(
    (await readFile(path, "utf8")).replace(/\n$/, ""),
  );
  return digest(`Basic ${Buffer.from(value).toString("base64")}`);
}

export function validateOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw Error("PUBLIC_ORIGIN must be an HTTPS origin");
  return url;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Tokens and the operator digest stay in this process, never in a browser bundle.
export async function createGateway({
  origin,
  operator,
  staticRoot,
  corePort,
  token,
  ready = () => true,
}) {
  const publicUrl = validateOrigin(origin);
  const root = await realpath(staticRoot);
  const upstreams = new Set();
  let closing = false;
  const server = createServer(async (req, res) => {
    const reply = (status, code) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        connection: "close",
      });
      res.end(JSON.stringify({ code }));
    };
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cache-control", "no-store");
    if (req.url === "/readyz" && req.method === "GET")
      return reply(
        !closing && ready() ? 200 : 503,
        !closing && ready() ? "READY" : "UNAVAILABLE",
      );
    if (closing || !ready()) return reply(503, "UNAVAILABLE");
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), operator)) {
      res.setHeader(
        "www-authenticate",
        'Basic realm="SceneSparrow", charset="UTF-8"',
      );
      return reply(401, "UNAUTHORIZED");
    }
    const documentNavigation =
      ["GET", "HEAD"].includes(req.method) &&
      ["/", "/index.html"].includes(req.url.split("?", 1)[0]) &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (
      req.headers.host !== publicUrl.host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"]) &&
        !documentNavigation)
    )
      return reply(403, "ORIGIN_DENIED");
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
      return reply(403, "ORIGIN_DENIED");
    try {
      // Inspect the raw path before WHATWG URL normalization can erase dot segments.
      const queryAt = req.url.indexOf("?");
      const rawPath = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
      const query = queryAt === -1 ? "" : req.url.slice(queryAt);
      const path = decodeURIComponent(rawPath);
      if (
        !path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part) => part === "." || part === "..") ||
        /%2f|%5c/i.test(rawPath)
      )
        return reply(400, "INVALID_PATH");
      if (path.startsWith("/api/")) {
        const target = path.slice(4);
        if (
          !target.startsWith("/v1/") ||
          /^\/v1\/(?:manuscript\/deliveries|project\/(?:quiesce|resume|backup))(?:\/|$)/.test(
            target,
          )
        )
          return reply(403, "ORIGIN_DENIED");
        if (Number(req.headers["content-length"] ?? 0) > UPLOAD_LIMIT)
          return reply(413, "INPUT_TOO_LARGE");
        const headers = { authorization: `Bearer ${token}`, origin };
        for (const name of [
          "content-type",
          "accept",
          "last-event-id",
          "x-intake-id",
          "x-file-name",
        ])
          if (typeof req.headers[name] === "string")
            headers[name] = req.headers[name];
        const upstream = httpRequest({
          host: "127.0.0.1",
          port: corePort,
          path: rawPath.slice(4) + query,
          method: req.method,
          headers,
        });
        upstreams.add(upstream);
        let exceeded = false;
        upstream.on("close", () => upstreams.delete(upstream));
        upstream.on("error", () => {
          if (!exceeded) reply(502, "UPSTREAM_UNAVAILABLE");
        });
        res.on("close", () => upstream.destroy());
        req.on("aborted", () => upstream.destroy());
        upstream.on("response", (incoming) => {
          if (exceeded) return incoming.destroy();
          if (
            Number(incoming.headers["content-length"] ?? 0) > DOWNLOAD_LIMIT
          ) {
            incoming.destroy();
            return reply(502, "OUTPUT_TOO_LARGE");
          }
          const responseHeaders = {};
          for (const name of ["content-type", "content-disposition"])
            if (incoming.headers[name])
              responseHeaders[name] = incoming.headers[name];
          // Flush immediately for SSE; pipe preserves backpressure and close cancels the core request.
          responseHeaders["x-accel-buffering"] = "no";
          res.writeHead(incoming.statusCode, responseHeaders);
          res.flushHeaders();
          let received = 0;
          const isEvents = String(incoming.headers["content-type"]).startsWith(
            "text/event-stream",
          );
          incoming.on("data", (chunk) => {
            received += chunk.length;
            if (!isEvents && received > DOWNLOAD_LIMIT) {
              incoming.destroy();
              res.destroy();
            }
          });
          incoming.on("error", () => res.destroy());
          incoming.pipe(res);
        });
        let sent = 0;
        req.on("data", (chunk) => {
          sent += chunk.length;
          if (sent > UPLOAD_LIMIT) {
            exceeded = true;
            upstream.destroy();
            reply(413, "INPUT_TOO_LARGE");
            return;
          }
          if (!exceeded && !upstream.write(chunk)) req.pause();
        });
        upstream.on("drain", () => req.resume());
        req.on("end", () => {
          if (!exceeded) upstream.end();
        });
        return;
      }
      if (!["GET", "HEAD"].includes(req.method))
        return reply(405, "METHOD_NOT_ALLOWED");
      const candidate = resolve(
        root,
        `.${path === "/" ? "/index.html" : path}`,
      );
      const filePath = await realpath(candidate);
      if (!filePath.startsWith(root + sep)) return reply(404, "NOT_FOUND");
      const file = await open(filePath, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return reply(404, "NOT_FOUND");
        res.writeHead(200, {
          "content-type": mime[extname(filePath)] ?? "application/octet-stream",
          "content-length": stat.size,
        });
        if (req.method === "HEAD") res.end();
        else await pipeline(file.createReadStream({ autoClose: false }), res);
      } finally {
        await file.close();
      }
    } catch {
      reply(404, "NOT_FOUND");
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  return {
    server,
    close: async () => {
      closing = true;
      for (const upstream of upstreams) upstream.destroy();
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await closed;
    },
  };
}
