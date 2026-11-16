/* Independent of the module graph: report only registered operational metadata. */
(() => {
  "use strict";
  if (location.protocol !== "https:" || window.sceneSparrow) return;
  const codes = new Set([
    "AUTH_REQUIRED",
    "HTTP_ERROR",
    "NETWORK_TIMEOUT",
    "NETWORK_FAILED",
    "RESPONSE_NOT_JSON",
    "RESPONSE_EMPTY",
    "RESPONSE_INVALID_JSON",
    "BOOTSTRAP_FAILED",
  ]);
  const routes = new Set([
    "document",
    "asset",
    "project",
    "manuscript",
    "ai",
    "events",
    "diagnostics",
    "health",
    "unknown",
  ]);
  const stages = new Set(["bootstrap", "request", "decode", "mounted"]);
  const suppliedBuild = document.querySelector(
    'meta[name="scenesparrow-build"]',
  )?.content;
  const appBuild = /^[a-f0-9]{7,40}$/.test(suppliedBuild || "")
    ? suppliedBuild
    : "unknown";
  const recent = new Map();
  let mounted = false,
    sent = 0,
    busy = false;
  const report = (input) => {
    try {
      if (
        window.sceneSparrow ||
        busy ||
        sent >= 30 ||
        !input ||
        !codes.has(input.code) ||
        !routes.has(input.routeId) ||
        !stages.has(input.stage)
      )
        return;
      const key = `${input.code}:${input.routeId}:${input.stage}`;
      const now = Date.now();
      if (now - (recent.get(key) ?? -Infinity) < 30000) return;
      recent.set(key, now);
      const event = {
        schemaVersion: 1,
        component: "client",
        level: "warn",
        eventCode: "CLIENT_FAILURE",
        code: input.code,
        routeId: input.routeId,
        stage: input.stage,
        appBuild,
      };
      if (
        Number.isInteger(input.status) &&
        input.status >= 100 &&
        input.status <= 599
      )
        event.status = input.status;
      if (
        typeof input.traceId === "string" &&
        /^[a-f0-9]{32}$/.test(input.traceId)
      )
        event.traceId = input.traceId;
      sent++;
      busy = true;
      // No response parsing, retry, persisted state or recursive diagnostics.
      Promise.resolve(
        fetch("/diagnostics/v1/client-events", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5000),
        }),
      )
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    } catch {
      busy = false;
    }
  };
  const bootstrapFailed = () => {
    if (!mounted)
      report({
        code: "BOOTSTRAP_FAILED",
        routeId: "document",
        stage: "bootstrap",
      });
  };
  window.sceneSparrowDiagnostics = {
    report,
    mounted: () => {
      mounted = true;
    },
  };
  window.addEventListener(
    "error",
    (event) => {
      if (event.target === window || event.target?.tagName === "SCRIPT")
        bootstrapFailed();
    },
    true,
  );
  window.addEventListener("unhandledrejection", bootstrapFailed);
})();
