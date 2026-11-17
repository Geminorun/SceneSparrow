import { test, expect, request as supportRequest } from "@playwright/test";
import { createServer, request } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startRuntime } from "../../scripts/web/start.mjs";
import { readOperator } from "../../scripts/web/gateway.mjs";

// Production gateway coverage is intentionally separate from the Vite entry.
// Traces can contain authentication headers, so keep only explicit safe screenshots.
test.use({ trace: "off" });
test.describe.configure({ mode: "serial" });
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let tls: ReturnType<typeof createSecureServer>;
let external: ReturnType<typeof createServer>;
let temporary: string;
let origin: string;
let externalOrigin: string;
const credentials = { username: "operator", password: "diagnostics-fixture" };
const trace = "e".repeat(32);

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
async function events(component: string) {
  await runtime.gateway.diagnostics.flush();
  return (
    await runtime.gateway.diagnostics.read(
      new URLSearchParams({ component, limit: "500" }),
    )
  ).events;
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  temporary = await mkdtemp(
    join(tmpdir(), "scenesparrow-browser-diagnostics-"),
  );
  const key = join(temporary, "test.key");
  const cert = join(temporary, "test.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  tls = createSecureServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (incoming, outgoing) => {
      if (!runtime) {
        outgoing.writeHead(503);
        outgoing.end();
        return;
      }
      const upstream = request(
        {
          host: "127.0.0.1",
          port: runtime.gateway.server.address().port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.on("error", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => outgoing.destroy());
      outgoing.on("close", () => upstream.destroy());
      incoming.on("aborted", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  origin = "https://127.0.0.1:" + (tls.address() as { port: number }).port;
  const auth = join(temporary, "auth");
  await writeFile(auth, credentials.username + ":" + credentials.password, {
    mode: 0o600,
  });
  runtime = await startRuntime({
    origin,
    operator: await readOperator(auth),
    binary: resolve("target/debug/scenesparrow-service"),
    staticRoot: resolve("apps/web/dist"),
    corePort: await unusedPort(),
    gatewayPort: 0,
    projectDir: join(temporary, "project"),
    appDataDir: join(temporary, "app"),
    signals: new EventEmitter(),
    onExit: () => {},
    version: "1.0.0",
    shutdownMs: 5000,
    quiesceMs: 3000,
  });
  external = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<a href="' +
        origin +
        '/">Application</a><a href="' +
        origin +
        '/diagnostics">Diagnostics</a>',
    );
  });
  external.listen(0, "127.0.0.1");
  await once(external, "listening");
  externalOrigin =
    "http://localhost:" + (external.address() as { port: number }).port;
  await mkdir(".artifacts", { recursive: true });
});
test.afterAll(async () => {
  await runtime?.stop();
  for (const server of [tls, external]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("RD-A01 fresh browser challenge, wrong/right Basic and external document navigation", async ({
  browser,
}) => {
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const challenge = await anonymous.request.get(origin, {
      headers: { accept: "text/html" },
    });
    expect(challenge.status()).toBe(401);
    expect(challenge.headers()["www-authenticate"]).toContain(
      'Basic realm="SceneSparrow"',
    );
    expect(challenge.headers()["content-type"]).toContain("text/html");
    expect(await challenge.text()).toContain("<html");
  } finally {
    await anonymous.close();
  }
  const wrong = await browser.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: { ...credentials, password: "wrong-fixture" },
  });
  try {
    const before = new Set(
      (await events("gateway")).map((event) => event.traceId),
    );
    const page = await wrong.newPage();
    let requested = false;
    page.on("request", (request) => {
      if (request.isNavigationRequest()) requested = true;
    });
    const response = await page.goto(origin).catch((error) => {
      expect(String(error)).toContain("ERR_INVALID_AUTH_CREDENTIALS");
      return null;
    });
    if (response) expect(response.status()).toBe(401);
    expect(requested).toBe(true);
    expect(
      (await events("gateway")).some(
        (event) =>
          event.eventCode === "AUTH_DENIED" &&
          event.routeId === "document" &&
          !before.has(event.traceId),
      ),
    ).toBe(true);
  } finally {
    await wrong.close();
  }
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const before = new Set(
      (await events("gateway")).map((event) => event.traceId),
    );
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const challenges: Array<{
      basic: boolean;
      origin: boolean;
      realm: boolean;
    }> = [];
    session.on("Fetch.requestPaused", (event) => {
      void session
        .send("Fetch.continueRequest", { requestId: event.requestId })
        .catch(() => {});
    });
    session.on("Fetch.authRequired", (event) => {
      challenges.push({
        basic: event.authChallenge.scheme.toLowerCase() === "basic",
        origin: event.authChallenge.origin === origin,
        realm: event.authChallenge.realm === "SceneSparrow",
      });
      void session
        .send("Fetch.continueWithAuth", {
          requestId: event.requestId,
          authChallengeResponse: {
            response: "ProvideCredentials",
            ...credentials,
          },
        })
        .catch(() => {});
    });
    await session.send("Fetch.enable", { handleAuthRequests: true });
    const response = await page.goto(origin);
    expect(response?.headers()["content-type"]).toContain("text/html");
    await expect(
      page.locator(".project-workbench[data-project-id]"),
    ).toBeVisible();
    expect(
      challenges.some(
        (challenge) => challenge.basic && challenge.origin && challenge.realm,
      ),
    ).toBe(true);
    expect(
      (await events("gateway")).some(
        (event) =>
          !before.has(event.traceId) &&
          event.routeId === "document" &&
          event.eventCode === "HTTP_COMPLETE" &&
          event.status === 401 &&
          event.responseKind === "html",
      ),
    ).toBe(true);
    await expect(page.getByTestId("transport-failure")).toHaveCount(0);
    await page.goto(externalOrigin);
    await page.getByRole("link", { name: "Application", exact: true }).click();
    await expect(
      page.locator(".project-workbench[data-project-id]"),
    ).toBeVisible();
    await page.goto(externalOrigin);
    await page.getByRole("link", { name: "Diagnostics", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "SceneSparrow diagnostics" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("RD-A06 mounted application shows safe localized response class, status and trace", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: credentials,
  });
  try {
    const page = await context.newPage();
    let ensureCalls = 0;
    await page.route("**/api/v1/project/ensure", (route) => {
      ensureCalls++;
      return route.continue();
    });
    await page.route("**/api/v1/project", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html",
          "X-SceneSparrow-Trace-Id": trace,
        },
        body: "<html>RESPONSE_BODY_CANARY</html>",
      }),
    );
    await page.goto(origin);
    const alert = page.getByTestId("transport-failure");
    await expect(alert).toContainText(
      "The server returned an unexpected response format.",
    );
    await alert.getByText("Details", { exact: true }).click();
    await expect(alert).toContainText("Core HTTP 200");
    await expect(alert).toContainText(trace);
    await expect(page.locator("body")).not.toContainText(
      "RESPONSE_BODY_CANARY",
    );
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(alert).toContainText("服务器返回了意外的响应格式。");
    await expect(alert).toContainText("核心服务 HTTP 200");
    await expect(alert).toContainText(trace);
    // A failed project read is never evidence of an empty workspace. Explicit
    // retry must retain the failure class and must not initialize a replacement.
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(alert).toContainText("服务器返回了意外的响应格式。");
    await expect(alert).toContainText(trace);
    expect(ensureCalls).toBe(0);
    await expect
      .poll(async () =>
        (await events("client")).some(
          (event) =>
            event.code === "RESPONSE_NOT_JSON" && event.traceId === trace,
        ),
      )
      .toBe(true);
    expect(JSON.stringify(await events("client"))).not.toContain(
      "RESPONSE_BODY_CANARY",
    );
    await page.screenshot({
      path: ".artifacts/diagnostics-transport.png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test("RD-A02 broken React bundle leaves diagnostics grants, reads and safe exports available", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: credentials,
    acceptDownloads: true,
  });
  const support = await supportRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.route("**/assets/*.js", (route) => route.abort());
    await page.goto(origin);
    await expect
      .poll(async () =>
        (await events("client")).some(
          (event) => event.code === "BOOTSTRAP_FAILED",
        ),
      )
      .toBe(true);
    await page.goto(origin + "/diagnostics");
    await page
      .getByRole("button", { name: "Refresh status", exact: true })
      .click();
    await expect(page.locator("#output")).toContainText(
      '"coreAvailable": true',
    );
    await page
      .getByRole("button", {
        name: "Create / replace read grant (15 minutes)",
        exact: true,
      })
      .click();
    await expect
      .poll(async () =>
        /^[A-Za-z0-9_-]{43}$/.test(await page.locator("#token").inputValue()),
      )
      .toBe(true);
    const token = await page.locator("#token").inputValue();
    const read = await support.get(origin + "/diagnostics/v1/status", {
      headers: { authorization: "Bearer " + token },
    });
    expect(read.status()).toBe(200);
    const denied = await support.get(origin + "/api/v1/project", {
      headers: { authorization: "Bearer " + token },
    });
    expect(denied.status()).toBe(403);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download safe bundle", exact: true })
      .click();
    const artifact = await download;
    const path = await artifact.path();
    const bytes = await readFile(path!);
    expect(bytes.length).toBeLessThanOrEqual(1048576);
    const bundle = JSON.parse(bytes.toString("utf8"));
    expect(bundle.schemaVersion).toBe(1);
    expect(Array.isArray(bundle.events)).toBe(true);
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(credentials.password))).toBe(false);
    await page
      .getByRole("button", { name: "Revoke read grant", exact: true })
      .click();
    await expect(page.locator("#token")).toHaveValue("");
    const revoked = await support.get(origin + "/diagnostics/v1/status", {
      headers: { authorization: "Bearer " + token },
    });
    expect(revoked.status()).toBe(401);
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("zh-CN");
    await expect(page.getByRole("heading", { name: "幕雀诊断" })).toBeVisible();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(page.locator("#output")).toContainText('"activeGrant": null');
    await page.screenshot({
      path: ".artifacts/diagnostics-page.png",
      fullPage: true,
    });
  } finally {
    await support.dispose();
    await context.close();
  }
});
