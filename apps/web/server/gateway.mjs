import { createServer, request as httpRequest } from "node:http";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { open, realpath, readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  createDiagnostics,
  createGrantStore,
  createDiagnosticLimiter,
  DiagnosticError,
  safeDiagnostic,
} from "./diagnostics.mjs";
import { diagnosticsPage, authenticationPage } from "./diagnostics-page.mjs";

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
  diagnostics,
  diagnosticsDirectory,
  version = "unknown",
  buildSha = "unknown",
}) {
  const publicUrl = validateOrigin(origin);
  const root = await realpath(staticRoot);
  const upstreams = new Set();
  let closing = false;
  const collector =
    diagnostics ??
    createDiagnostics({
      directory: diagnosticsDirectory,
      version,
      buildSha,
      coreAvailable: ready,
    });
  const grants = createGrantStore();
  const limit = createDiagnosticLimiter();
  let securityMinute = 0,
    securityEvents = 0;
  const server = createServer(async (req, res) => {
    const traceId = randomBytes(16).toString("hex");
    const began = performance.now();
    const rawRoute = req.url.split("?", 1)[0];
    const diagnosticRoute =
      rawRoute === "/diagnostics" || rawRoute.startsWith("/diagnostics/");
    const routeId = diagnosticRoute
      ? "diagnostics"
      : ["/", "/index.html"].includes(rawRoute)
        ? "document"
        : rawRoute === "/readyz"
          ? "health"
          : ["/api/v1/events", "/api/v1/project/events"].includes(rawRoute)
            ? "events"
            : rawRoute.startsWith("/api/v1/project")
              ? "project"
              : rawRoute.startsWith("/api/v1/manuscript")
                ? "manuscript"
                : rawRoute.startsWith("/api/v1/ai")
                  ? "ai"
                  : rawRoute.startsWith("/assets/") ||
                      rawRoute === "/bootstrap-diagnostics.js"
                    ? "asset"
                    : "unknown";
    const documentNavigation =
      ["GET", "HEAD"].includes(req.method) &&
      ["/", "/index.html", "/diagnostics"].includes(rawRoute) &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    const documentRequest =
      ["GET", "HEAD"].includes(req.method) &&
      ["/", "/index.html", "/diagnostics"].includes(rawRoute) &&
      (documentNavigation || String(req.headers.accept).includes("text/html"));
    let responseBytes = 0,
      completion = "complete",
      security = false,
      completed = false;
    const write = res.write.bind(res),
      end = res.end.bind(res);
    const count = (chunk, encoding) => {
      if (chunk)
        responseBytes = Math.min(
          1099511627776,
          responseBytes +
            (typeof chunk === "string"
              ? Buffer.byteLength(
                  chunk,
                  typeof encoding === "string" ? encoding : undefined,
                )
              : chunk.length),
        );
    };
    res.write = (chunk, ...args) => {
      count(chunk, args[0]);
      return write(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
      count(chunk, args[0]);
      return end(chunk, ...args);
    };
    function event(eventCode, extra = {}) {
      if (security || routeId === "health") {
        const minute = Math.floor(Date.now() / 60000);
        if (minute !== securityMinute) {
          securityMinute = minute;
          securityEvents = 0;
        }
        if (securityEvents++ >= 60) {
          collector.drop();
          return;
        }
      }
      collector.emit({
        schemaVersion: 1,
        component: "gateway",
        level: security ? "warn" : "info",
        eventCode,
        stage: "request",
        routeId,
        method: req.method,
        traceId,
        cfRay: req.headers["cf-ray"],
        ...extra,
      });
    }
    function finish(aborted) {
      if (completed) return;
      completed = true;
      const type = String(res.getHeader("content-type") ?? "").split(";", 1)[0];
      const responseKind =
        {
          "text/html": "html",
          "application/json": "json",
          "text/event-stream": "event-stream",
          "text/plain": "text",
        }[type] ?? (responseBytes ? "binary" : "empty");
      event(aborted ? "HTTP_ABORTED" : "HTTP_COMPLETE", {
        status: res.statusCode,
        durationMs: Math.min(
          86400000,
          Math.max(0, Math.round(performance.now() - began)),
        ),
        responseBytes,
        responseKind,
        completion: aborted
          ? completion === "truncated"
            ? completion
            : "aborted"
          : completion,
      });
    }
    res.once("finish", () => finish(false));
    res.once("close", () => finish(!res.writableFinished));
    res.setHeader("x-scenesparrow-trace-id", traceId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("cache-control", "no-store");
    const reply = (status, code, bearer = false) => {
      if (res.headersSent) return res.destroy();
      const html =
        documentRequest && !bearer && !rawRoute.startsWith("/diagnostics/v1/");
      res.writeHead(status, {
        "content-type": html
          ? "text/html; charset=utf-8"
          : "application/json; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        connection: "close",
      });
      res.end(
        req.method === "HEAD"
          ? undefined
          : html
            ? authenticationPage(code, traceId, req.headers["accept-language"])
            : JSON.stringify({ code, traceId }),
      );
    };
    const json = (status, value) => {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > 1048576)
        return reply(503, "DIAGNOSTICS_UNAVAILABLE");
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(body);
    };
    if (req.url === "/readyz" && req.method === "GET")
      return reply(
        !closing && ready() ? 200 : 503,
        !closing && ready() ? "READY" : "UNAVAILABLE",
      );
    if (req.headers.host !== publicUrl.host) {
      security = true;
      event("ORIGIN_DENIED");
      return reply(403, "ORIGIN_DENIED");
    }
    const bearer = /^Bearer(?:\s|$)/i.test(req.headers.authorization ?? "");
    let credential = "operator";
    if (bearer) {
      try {
        credential = grants.authorize(
          String(req.headers.authorization).slice(7),
        );
      } catch (error) {
        security = true;
        event("AUTH_DENIED");
        res.setHeader(
          "www-authenticate",
          'Bearer realm="SceneSparrow diagnostics"',
        );
        return reply(401, error.code ?? "UNAUTHORIZED", true);
      }
      if (
        req.method !== "GET" ||
        ![
          "/diagnostics/v1/status",
          "/diagnostics/v1/logs",
          "/diagnostics/v1/bundle",
        ].includes(rawRoute)
      )
        return reply(403, "DIAGNOSTICS_SCOPE_DENIED", true);
    } else if (
      !timingSafeEqual(digest(req.headers.authorization ?? ""), operator)
    ) {
      security = true;
      event("AUTH_DENIED");
      res.setHeader(
        "www-authenticate",
        'Basic realm="SceneSparrow", charset="UTF-8"',
      );
      return reply(401, "UNAUTHORIZED");
    }
    if (
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] !== undefined &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"]) &&
        !documentNavigation) ||
      (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
    ) {
      security = true;
      event("ORIGIN_DENIED");
      return reply(403, "ORIGIN_DENIED", bearer);
    }
    if (diagnosticRoute) {
      try {
        if (closing) throw new DiagnosticError(503, "DIAGNOSTICS_UNAVAILABLE");
        const url = new URL(req.url, origin);
        const expected = {
          "/diagnostics": "GET",
          "/diagnostics/v1/status": "GET",
          "/diagnostics/v1/logs": "GET",
          "/diagnostics/v1/bundle": "GET",
          "/diagnostics/v1/access-grants": "POST",
          "/diagnostics/v1/access-grants/revoke": "POST",
          "/diagnostics/v1/client-events": "POST",
        }[rawRoute];
        if (!expected) throw new DiagnosticError(404, "NOT_FOUND");
        if (req.method !== expected)
          throw new DiagnosticError(405, "METHOD_NOT_ALLOWED");
        if (
          !["/diagnostics/v1/logs", "/diagnostics/v1/bundle"].includes(
            rawRoute,
          ) &&
          url.search
        )
          throw new DiagnosticError(400, "INVALID_DIAGNOSTICS_QUERY");
        if (rawRoute === "/diagnostics") {
          const page = diagnosticsPage();
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": page.csp,
          });
          return res.end(page.html);
        }
        if (req.method === "GET") {
          limit("read", credential);
          if (rawRoute.endsWith("/status"))
            return json(200, {
              ...collector.status(),
              activeGrant:
                credential === "operator" ? grants.status() : undefined,
            });
          if (rawRoute.endsWith("/bundle")) {
            limit("bundle");
            res.setHeader(
              "content-disposition",
              'attachment; filename="scenesparrow-diagnostics.json"',
            );
            return json(200, await collector.bundle(url.searchParams));
          }
          return json(200, await collector.read(url.searchParams));
        }
        const clientEvent = rawRoute.endsWith("/client-events");
        limit(clientEvent ? "client" : "grant");
        const body = await diagnosticBody(req, clientEvent);
        if (clientEvent) {
          const safe = safeDiagnostic(body);
          const allowed = [
            "schemaVersion",
            "component",
            "level",
            "eventCode",
            "stage",
            "routeId",
            "code",
            "status",
            "traceId",
            "appBuild",
          ];
          if (
            !safe ||
            body.component !== "client" ||
            body.level !== "warn" ||
            body.eventCode !== "CLIENT_FAILURE" ||
            ![
              "AUTH_REQUIRED",
              "HTTP_ERROR",
              "NETWORK_TIMEOUT",
              "NETWORK_FAILED",
              "RESPONSE_NOT_JSON",
              "RESPONSE_EMPTY",
              "RESPONSE_INVALID_JSON",
              "BOOTSTRAP_FAILED",
            ].includes(body.code) ||
            !["request", "decode", "bootstrap", "mounted"].includes(
              body.stage,
            ) ||
            !safe.routeId ||
            Object.keys(body).some((key) => !allowed.includes(key)) ||
            Object.keys(body).some((key) => safe[key] !== body[key])
          )
            throw new DiagnosticError(400, "INVALID_DIAGNOSTICS_EVENT");
          collector.emit(safe);
          return json(202, { accepted: true });
        }
        if (rawRoute.endsWith("/revoke")) {
          if (Object.keys(body).length)
            throw new DiagnosticError(400, "INVALID_DIAGNOSTICS_QUERY");
          return json(200, grants.revoke());
        }
        return json(201, grants.mint(body));
      } catch (error) {
        if (error instanceof DiagnosticError && error.status === 429)
          res.setHeader("retry-after", "60");
        return reply(
          error instanceof DiagnosticError ? error.status : 503,
          error instanceof DiagnosticError
            ? error.code
            : "DIAGNOSTICS_UNAVAILABLE",
          bearer,
        );
      }
    }
    if (closing || !ready()) return reply(503, "UNAVAILABLE");
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
        const headers = {
          authorization: `Bearer ${token}`,
          origin,
          "x-scenesparrow-trace-id": traceId,
        };
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
          if (!exceeded) {
            event("UPSTREAM_FAILED", { level: "error" });
            reply(502, "UPSTREAM_UNAVAILABLE");
          }
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
          if (isEvents) event("SSE_OPEN");
          incoming.on("data", (chunk) => {
            received += chunk.length;
            if (!isEvents && received > DOWNLOAD_LIMIT) {
              completion = "truncated";
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
    diagnostics: collector,
    close: async () => {
      closing = true;
      for (const upstream of upstreams) upstream.destroy();
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await closed;
      if (!diagnostics) await collector.close(250);
    },
  };
}

async function diagnosticBody(req, clientEvent = false) {
  const invalidCode = clientEvent
    ? "INVALID_DIAGNOSTICS_EVENT"
    : "INVALID_DIAGNOSTICS_QUERY";
  if (Number(req.headers["content-length"] ?? 0) > 4096) {
    req.resume();
    throw new DiagnosticError(413, "INPUT_TOO_LARGE");
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const timer = setTimeout(
      () => fail(new DiagnosticError(400, invalidCode)),
      5000,
    );
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("aborted", abort);
      req.removeListener("error", abort);
    };
    const fail = (error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > 4096) fail(new DiagnosticError(413, "INPUT_TOO_LARGE"));
      else chunks.push(chunk);
    };
    const abort = () => fail(new DiagnosticError(400, invalidCode));
    const end = () => {
      cleanup();
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error();
        resolve(value);
      } catch {
        reject(new DiagnosticError(400, invalidCode));
      }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("aborted", abort);
    req.once("error", abort);
  });
}
