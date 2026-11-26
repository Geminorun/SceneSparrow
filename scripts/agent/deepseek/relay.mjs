// This trusted module runs outside the network-disabled native runner.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmod, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEADLINE, MAX_INPUT, MAX_OUTPUT } from "./policy.mjs";

// Both hops admit only the native Messages request. No URL is accepted from ACP.
export function providerProxy(connect) {
  return createServer((incoming, outgoing) => {
    if (
      incoming.method !== "POST" ||
      incoming.url !== "/anthropic/v1/messages"
    ) {
      outgoing.writeHead(403).end();
      incoming.resume();
      return;
    }
    const headers = {};
    for (const name of [
      "content-type",
      "x-api-key",
      "anthropic-version",
      "anthropic-beta",
    ])
      if (incoming.headers[name] !== undefined)
        headers[name] = incoming.headers[name];
    let request;
    let input = 0;
    let output = 0;
    let timer;
    const stop = () => request?.destroy();
    try {
      request = connect(
        { method: "POST", path: incoming.url, headers },
        (response) => {
          outgoing.writeHead(response.statusCode, {
            "content-type":
              response.headers["content-type"] ?? "application/json",
          });
          response.on("data", (chunk) => {
            output += chunk.length;
            if (output > MAX_OUTPUT) {
              response.destroy();
              outgoing.destroy();
            }
          });
          response.on("error", () => outgoing.destroy());
          response.pipe(outgoing);
        },
      );
      timer = setTimeout(() => {
        stop();
        outgoing.destroy();
      }, DEADLINE);
      outgoing.once("close", () => clearTimeout(timer));
      request.setTimeout(DEADLINE, () => {
        stop();
        outgoing.destroy();
      });
      request.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502).end();
        else outgoing.destroy();
      });
      incoming.on("data", (chunk) => {
        input += chunk.length;
        if (input > MAX_INPUT) {
          stop();
          incoming.destroy();
          outgoing.destroy();
        }
      });
      incoming.on("aborted", stop);
      outgoing.on("close", stop);
      incoming.pipe(request);
    } catch {
      stop();
      outgoing.destroy();
    }
  });
}

export async function startProviderRelay(directory, fixturePort) {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    metadata.uid !== process.getuid()
  )
    throw Error("Relay requires a private owned socket directory");
  if (
    fixturePort !== undefined &&
    (!Number.isInteger(fixturePort) || fixturePort < 1 || fixturePort > 65535)
  )
    throw Error("Invalid fixture port");
  const server = providerProxy((options, callback) =>
    fixturePort === undefined
      ? httpsRequest(
          { ...options, hostname: "api.deepseek.com", port: 443 },
          callback,
        )
      : httpRequest(
          { ...options, hostname: "127.0.0.1", port: fixturePort },
          callback,
        ),
  );
  const socket = `${directory}/provider.sock`;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [directory] = process.argv.slice(2);
  if (!directory || process.argv.length !== 3)
    throw Error("Usage: node relay.mjs ABS_PRIVATE_SOCKET_DIR");
  const server = await startProviderRelay(directory);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
