import {
  generate,
  discoverModels,
  sha256,
  validateRequest,
  normalizeError,
  AiFailure,
} from "@scenesparrow/ai-runtime";
const MAX_FRAME = 4 * 1024 * 1024;
const abort = new AbortController();
let start,
  input,
  credential,
  leased = false,
  dispatched = false,
  ended = false,
  total = 0;
const artifacts = new Map(),
  chunks = new Map();
let preview = 0;
function send(value) {
  if (ended) return;
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new AiFailure("PROTOCOL_MISMATCH");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  process.stdout.write(length);
  process.stdout.write(body);
}
function stop(code) {
  if (ended) return;
  send({ type: "failed", code });
  ended = true;
  credential = null;
  process.stdin.destroy();
  process.exitCode = 1;
}
function check(ok, code = "PROTOCOL_MISMATCH") {
  if (!ok) throw new AiFailure(code);
}
async function execute() {
  try {
    const signal = abort.signal;
    let bytes,
      usage = null;
    if (start.operation === "discover") {
      bytes = Buffer.from(
        JSON.stringify({
          models: await discoverModels(start.configuration, credential, signal),
        }),
      );
    } else {
      const result = await generate({
        input,
        configuration: start.configuration,
        credential,
        artifacts: async (id) => {
          check(artifacts.has(id), "ARTIFACT_MISMATCH");
          return artifacts.get(id);
        },
        signal,
        emit: (event) => {
          if (event.type === "started") return;
          if (event.type === "output_delta") {
            const size = Buffer.byteLength(event.text);
            if (preview + size <= 262144) {
              preview += size;
              send(event);
            }
          } else send(event);
        },
      });
      bytes = result.bytes;
      usage = result.usage;
    }
    for (let at = 0; at < bytes.length; at += 24576)
      send({
        type: "output_chunk",
        data: Buffer.from(bytes.subarray(at, at + 24576)).toString("base64"),
      });
    send({
      type: "completed",
      receipt: {
        runId: start.runId,
        attempt: start.attempt,
        fence: start.fence,
        inputHash: start.inputHash,
        outputHash: sha256(bytes),
        finishReason: "stop",
        usage,
      },
    });
    ended = true;
    credential = null;
    process.stdin.destroy();
  } catch (error) {
    stop(normalizeError(error, abort.signal).code);
  }
}
async function handle(frame) {
  check(frame && typeof frame === "object");
  if (frame.type === "start") {
    check(
      !start &&
        frame.protocolVersion === 1 &&
        frame.attempt === 1 &&
        ["generate", "discover"].includes(frame.operation),
    );
    start = frame;
    send({
      type: "started",
      runId: start.runId,
      attempt: start.attempt,
      fence: start.fence,
    });
  } else {
    check(start && !ended);
    if (frame.type === "artifact_chunk") {
      check(
        !dispatched &&
          typeof frame.data === "string" &&
          frame.data.length <= 65536 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data),
      );
      const bytes = Buffer.from(frame.data, "base64");
      total += bytes.length;
      check(
        total <= 26 * 1024 * 1024 && !artifacts.has(frame.id),
        "INPUT_TOO_LARGE",
      );
      const list = chunks.get(frame.id) ?? [];
      check(list.length <= 1024, "INPUT_TOO_LARGE");
      list.push(bytes);
      chunks.set(frame.id, list);
      check(chunks.size <= 10, "INPUT_TOO_LARGE");
    } else if (frame.type === "artifact_end") {
      check(!dispatched && !artifacts.has(frame.artifact.id));
      const a = frame.artifact,
        bytes = Buffer.concat(chunks.get(a.id) ?? []);
      chunks.delete(a.id);
      check(
        bytes.length === a.size && sha256(bytes) === a.hash,
        "ARTIFACT_MISMATCH",
      );
      if (a.id === start.runId) {
        check(
          !input &&
            a.hash === start.inputHash &&
            a.mime === "application/json" &&
            bytes.length <= 8 * 1024 * 1024,
        );
        input = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } else {
        check(
          input &&
            input.inputArtifacts.some(
              (item) =>
                item.id === a.id &&
                item.hash === a.hash &&
                item.size === a.size &&
                item.mime === a.mime,
            ),
          "ARTIFACT_MISMATCH",
        );
        artifacts.set(a.id, bytes);
      }
    } else if (frame.type === "credential_lease") {
      check(
        !leased &&
          !dispatched &&
          frame.runId === start.runId &&
          frame.fence === start.fence &&
          (frame.secret === null ||
            (typeof frame.secret === "string" && frame.secret.length <= 8192)),
      );
      credential = frame.secret;
      leased = true;
      check(input && chunks.size === 0);
      await validateRequest({
        input,
        configuration: start.configuration,
        credential,
        artifacts: async (id) => {
          check(artifacts.has(id), "ARTIFACT_MISMATCH");
          return artifacts.get(id);
        },
        signal: abort.signal,
      });
      send({ type: "progress", runId: start.runId, phase: "dispatch_ready" });
    } else if (frame.type === "dispatch_permit") {
      check(
        leased &&
          !dispatched &&
          frame.runId === start.runId &&
          frame.fence === start.fence,
      );
      dispatched = true;
      void execute();
    } else if (frame.type === "abort") {
      check(frame.runId === start.runId && frame.fence === start.fence);
      abort.abort("CANCELLED");
    } else check(false);
  }
}
let pending = Buffer.alloc(0);
try {
  for await (const bytes of process.stdin) {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4) {
      const size = pending.readUInt32BE();
      check(size > 0 && size <= MAX_FRAME);
      if (pending.length < size + 4) break;
      const frame = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          pending.subarray(4, size + 4),
        ),
      );
      pending = pending.subarray(size + 4);
      await handle(frame);
    }
    check(pending.length <= MAX_FRAME + 4);
  }
  if (!ended) {
    abort.abort("CANCELLED");
    stop("WORKER_INTERRUPTED");
  }
} catch (error) {
  if (!ended)
    stop(error instanceof AiFailure ? error.code : "PROTOCOL_MISMATCH");
}
