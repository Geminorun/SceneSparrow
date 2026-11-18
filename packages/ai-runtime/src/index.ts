import OpenAI from "openai";
import Ajv from "ajv";
import { createHash } from "node:crypto";
import type {
  AiInput,
  AiResolvedConfig,
  AiUsage,
} from "@scenesparrow/contracts";

export class AiFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => {
  throw new AiFailure(code);
};
export type ArtifactBroker = (id: string) => Promise<Uint8Array>;
export type RuntimeEvent =
  | { type: "started" }
  | { type: "output_delta"; text: string }
  | { type: "usage"; usage: AiUsage };
export interface RuntimeRequest {
  input: AiInput;
  configuration: AiResolvedConfig;
  artifacts: ArtifactBroker;
  credential: string | null;
  signal: AbortSignal;
  emit?: (event: RuntimeEvent) => void;
}
export interface RuntimeResult {
  bytes: Uint8Array;
  usage: AiUsage | null;
  finishReason: "stop";
}
const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });
function check(ok: unknown, code = "INVALID_INPUT"): asserts ok {
  if (!ok) fail(code);
}
function validateRoot(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("INVALID_URL");
  }
  check(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "INVALID_URL",
  );
  return value.replace(/\/+$/, "");
}
/** Shared by listing and inference. Node's configured system trust/proxy is retained.
 * Redirects are rejected before the SDK could forward an Authorization header. */
export function transport(
  configuration: AiResolvedConfig,
  credential: string | null,
  signal: AbortSignal,
  timeout = configuration.policy.overallMs,
) {
  check(
    configuration.provider.authMode === "none" || !!credential,
    "CREDENTIAL_UNAVAILABLE",
  );
  const boundedFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail("ENDPOINT_REDIRECT");
    }
    // SDK error messages and bodies never cross the adapter. Bound even malicious
    // compatible responses before SDK parsing; visible output has its tighter limit.
    if (!response.body) return response;
    let count = 0;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            controller.close();
            return;
          }
          count += item.value.byteLength;
          if (count > 32 * 1024 * 1024) {
            await reader.cancel();
            controller.error(new AiFailure("OUTPUT_SIZE_LIMIT"));
            return;
          }
          controller.enqueue(item.value);
        } catch {
          controller.error(new AiFailure("NETWORK_FAILED"));
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return new OpenAI({
    baseURL: validateRoot(configuration.provider.baseUrl),
    apiKey: credential ?? "scenesparrow-local-no-auth",
    maxRetries: 0,
    logLevel: "off",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timeout,
    fetch: boundedFetch,
    ...(configuration.provider.authMode === "none"
      ? { defaultHeaders: { Authorization: null } }
      : {}),
  });
}
export function normalizeError(
  error: unknown,
  signal?: AbortSignal,
  operation: "generate" | "discovery" = "generate",
): AiFailure {
  if (signal?.aborted)
    return new AiFailure(
      signal.reason === "CANCELLED" ? "CANCELLED" : "REQUEST_TIMEOUT",
    );
  if (error instanceof AiFailure) return error;
  if (
    error instanceof OpenAI.APIConnectionError &&
    error.cause instanceof AiFailure
  )
    return error.cause;
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new AiFailure("REQUEST_TIMEOUT");
  if (error instanceof OpenAI.APIError) {
    // Only known machine codes carry quota meaning. Vendor prose is untrusted.
    const quota = new Set([
      "insufficient_quota",
      "billing_hard_limit_reached",
      "balance_insufficient",
    ]);
    return new AiFailure(
      error.status === 401
        ? "AUTH_REJECTED"
        : error.status === 403
          ? "ACCESS_REJECTED"
          : (error.status === 429 || error.status === 402) &&
              quota.has(error.code ?? "")
            ? "QUOTA_EXCEEDED"
            : error.status === 429
              ? "RATE_LIMITED"
              : operation === "discovery" && error.status === 404
                ? "MODEL_LIST_NOT_FOUND"
                : operation === "discovery" && error.status === 405
                  ? "MODEL_LIST_UNSUPPORTED"
                  : error.status === 404
                    ? "MODEL_UNAVAILABLE"
                    : error.status !== undefined && error.status >= 500
                      ? "PROVIDER_SERVER_FAILED"
                      : "PROVIDER_REJECTED",
    );
  }
  return new AiFailure("NETWORK_FAILED");
}
function boundedSchema(value: unknown) {
  // A structural subset has bounded work. In particular no regex, dynamic refs,
  // combinatorial alternatives, custom formats or recursive references execute.
  const keywords = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "enum",
    "const",
    "$ref",
    "$defs",
    "definitions",
    "description",
    "title",
    "anyOf",
  ]);
  let nodes = 0;
  function walk(
    v: unknown,
    depth: number,
    ancestors = new Set<unknown>(),
    map = false,
  ) {
    check(depth <= 16 && ++nodes <= 2048, "INVALID_OUTPUT_SCHEMA");
    if (!v || typeof v !== "object") return;
    check(!ancestors.has(v), "INVALID_OUTPUT_SCHEMA");
    const next = new Set(ancestors);
    next.add(v);
    if (Array.isArray(v)) {
      check(v.length <= 128, "INVALID_OUTPUT_SCHEMA");
      for (const child of v) walk(child, depth + 1, next);
      return;
    }
    for (const [key, child] of Object.entries(v)) {
      check(map || keywords.has(key), "INVALID_OUTPUT_SCHEMA");
      if (key === "$ref" && !map) {
        check(
          typeof child === "string" &&
            /^#\/(?:\$defs|definitions)\/[A-Za-z0-9_-]+$/.test(child),
          "INVALID_OUTPUT_SCHEMA",
        );
        let target: unknown = value;
        for (const part of child.slice(2).split("/"))
          target =
            target && typeof target === "object"
              ? (target as Record<string, unknown>)[part]
              : undefined;
        check(target, "INVALID_OUTPUT_SCHEMA");
        walk(target, depth + 1, next);
      } else if (key === "anyOf" && !map) {
        check(
          Array.isArray(child) &&
            child.length === 2 &&
            child.some(
              (v) =>
                v &&
                typeof v === "object" &&
                Object.keys(v).length === 1 &&
                v.type === "null",
            ),
          "INVALID_OUTPUT_SCHEMA",
        );
        walk(child, depth + 1, next);
      } else if ((key === "enum" || key === "const") && !map) {
        const list = key === "enum" ? child : [child];
        check(
          Array.isArray(list) &&
            list.length <= 128 &&
            list.every(
              (v) =>
                (typeof v === "string" && v.length <= 256) ||
                typeof v === "number" ||
                typeof v === "boolean" ||
                v === null,
            ),
          "INVALID_OUTPUT_SCHEMA",
        );
      } else if (key === "additionalProperties" && !map)
        check(typeof child === "boolean", "INVALID_OUTPUT_SCHEMA");
      else
        walk(
          child,
          depth + 1,
          next,
          !map && ["properties", "$defs", "definitions"].includes(key),
        );
    }
  }
  walk(value, 0);
  try {
    return new Ajv({
      strict: true,
      allErrors: false,
      validateFormats: false,
      loopRequired: 32,
      loopEnum: 32,
    }).compile(value as object);
  } catch {
    return fail("INVALID_OUTPUT_SCHEMA");
  }
}
function validateOutput(
  output: string,
  input: AiInput,
  validator?: (value: unknown) => unknown,
) {
  check(
    encoder.encode(output).byteLength <= input.outputSpec.maxBytes,
    "OUTPUT_SIZE_LIMIT",
  );
  check(
    output.trim().length > 0 &&
      !output.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        output,
      ),
    "INVALID_OUTPUT",
  );
  if (input.outputSpec.mime === "application/json") {
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      return fail("INVALID_OUTPUT");
    }
    let count = 0;
    const walk = (v: unknown, depth: number) => {
      check(++count <= 100000 && depth <= 32, "INVALID_OUTPUT");
      if (v && typeof v === "object")
        for (const child of Object.values(v)) walk(child, depth + 1);
    };
    walk(value, 0);
    check(!validator || validator(value), "INVALID_OUTPUT");
  }
}
function promptJsonInstruction(schema: object | undefined) {
  return `Return only JSON matching this structural schema. No markdown fences.\n${schema ? JSON.stringify(schema) : "Any valid JSON value."}`;
}
export async function validateRequest(request: RuntimeRequest) {
  if (request.signal.aborted) throw normalizeError(null, request.signal);
  const { input, configuration: c } = request;
  check(input.protocolVersion === 1, "PROTOCOL_MISMATCH");
  check(
    c.capability === "text.generate" && c.category === "text",
    "CAPABILITY_UNSUPPORTED",
  );
  check(
    input.messages.length > 0 && input.messages.length <= 128,
    "INPUT_TOO_LARGE",
  );
  check(
    input.outputSpec.maxBytes > 0 &&
      input.outputSpec.maxBytes <= Math.min(8388608, c.policy.maxOutputBytes),
    "INPUT_TOO_LARGE",
  );
  check(
    c.parameters.temperatureMilli === null ||
      (c.parameters.temperatureMilli >= 0 &&
        c.parameters.temperatureMilli <= 2000),
  );
  check(
    !c.stream || c.model.capabilities.streaming.state === "supported",
    "CAPABILITY_UNSUPPORTED",
  );
  check(
    !c.nativeJson || c.model.capabilities.nativeJson.state === "supported",
    "CAPABILITY_UNSUPPORTED",
  );
  let bytes = 0,
    images = 0,
    imageBytes = 0;
  const seen = new Set<string>();
  const artifacts = new Map<string, Uint8Array>();
  check(input.inputArtifacts.length <= 9, "INPUT_TOO_LARGE");
  for (const a of input.inputArtifacts) {
    check(
      !seen.has(a.id) &&
        /^[0-9a-f-]{36}$/.test(a.id) &&
        /^[0-9a-f]{64}$/.test(a.hash),
    );
    seen.add(a.id);
    check(
      a.size >= 0 &&
        a.size <= (a.mime.startsWith("image/") ? 4194304 : 1048576),
      "INPUT_TOO_LARGE",
    );
    const data = await request.artifacts(a.id);
    check(
      data.byteLength === a.size && sha256(data) === a.hash,
      "ARTIFACT_MISMATCH",
    );
    artifacts.set(a.id, data);
    if (a.mime.startsWith("image/")) imageBytes += a.size;
  }
  for (const message of input.messages) {
    check(
      ["system", "user", "assistant"].includes(message.role) &&
        message.content.length <= 256,
    );
    for (const p of message.content) {
      if (p.type === "text") {
        check(!p.text.includes("\0"));
        bytes += encoder.encode(p.text).byteLength;
      } else {
        images++;
        check(
          input.inputArtifacts.some(
            (a) =>
              a.id === p.artifactId &&
              ["image/png", "image/jpeg", "image/webp"].includes(a.mime),
          ),
        );
      }
    }
  }
  check(
    bytes <= 1048576 && images <= 8 && imageBytes <= 16777216,
    "INPUT_TOO_LARGE",
  );
  check(
    images === 0 ||
      (c.model.capabilities.images.state !== "unsupported" &&
        (c.model.capabilities.images.state === "supported" ||
          input.imageDecision === "attempt")),
    "CAPABILITY_UNSUPPORTED",
  );
  let schema: object | undefined;
  let validator: ReturnType<InstanceType<typeof Ajv>["compile"]> | undefined;
  if (input.outputSpec.schemaArtifactId) {
    const data = artifacts.get(input.outputSpec.schemaArtifactId);
    check(
      data &&
        input.inputArtifacts.some(
          (a) =>
            a.id === input.outputSpec.schemaArtifactId &&
            a.mime === "application/json",
        ),
    );
    try {
      schema = JSON.parse(utf8.decode(data));
    } catch {
      fail("INVALID_OUTPUT_SCHEMA");
    }
    validator = boundedSchema(schema);
  }
  const promptJson =
    input.outputSpec.mime === "application/json" && !c.nativeJson;
  const nativeSchema =
    input.outputSpec.mime === "application/json" && c.nativeJson;
  check(!nativeSchema || !!schema, "INVALID_OUTPUT_SCHEMA");
  const messageCount = input.messages.length + (promptJson ? 1 : 0);
  const adapterBytes = promptJson
    ? encoder.encode(promptJsonInstruction(schema)).byteLength
    : nativeSchema
      ? encoder.encode(JSON.stringify(schema)).byteLength
      : 0;
  const wireTextBytes = bytes + adapterBytes;
  check(messageCount <= 128 && wireTextBytes <= 1048576, "INPUT_TOO_LARGE");
  check(
    c.model.contextTokens === null ||
      Math.ceil(
        (wireTextBytes + messageCount * 32 + (nativeSchema ? 128 : 0)) / 3,
      ) +
        images * 4096 <=
        c.model.contextTokens,
    "CONTEXT_LIMIT",
  );
  return { artifacts, schema, validator };
}
export async function generate(
  request: RuntimeRequest,
): Promise<RuntimeResult> {
  const { configuration: c, input, signal } = request;
  const { artifacts, schema, validator } = await validateRequest(request);
  const overall = AbortSignal.timeout(c.policy.overallMs);
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, overall, abort.signal]);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(idle);
    idle = setTimeout(() => abort.abort("REQUEST_TIMEOUT"), c.policy.idleMs);
  };
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    input.messages.map((m) => ({
      role: m.role,
      content: m.content.map((p) =>
        p.type === "text"
          ? { type: "text" as const, text: p.text }
          : {
              type: "image_url" as const,
              image_url: {
                url: `data:${input.inputArtifacts.find((a) => a.id === p.artifactId)!.mime};base64,${Buffer.from(artifacts.get(p.artifactId)!).toString("base64")}`,
              },
            },
      ),
    })) as OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  if (input.outputSpec.mime === "application/json" && !c.nativeJson)
    messages.unshift({
      role: "system",
      content: promptJsonInstruction(schema),
    });
  const parameters = {
    model: c.model.id,
    messages,
    n: 1 as const,
    ...(c.parameters.temperatureMilli === null
      ? {}
      : { temperature: c.parameters.temperatureMilli / 1000 }),
    ...(c.nativeJson && schema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: "consumer_output",
              strict: true,
              schema: schema as Record<string, unknown>,
            },
          },
        }
      : {}),
  };
  let output = "",
    length = 0,
    finish: string | null = null,
    usage: AiUsage | null = null;
  let previewPending = "",
    safePreview = "",
    secretScan = "";
  const emitPreview = (text: string) => {
    let chunk = "";
    for (const scalar of text) {
      chunk += scalar;
      if (chunk.length >= 4096) {
        request.emit?.({ type: "output_delta", text: chunk });
        chunk = "";
      }
    }
    if (chunk) request.emit?.({ type: "output_delta", text: chunk });
  };
  const append = (text: string) => {
    check(typeof text === "string", "INVALID_OUTPUT");
    if (request.credential) {
      const scan = secretScan + text;
      check(!scan.includes(request.credential), "INVALID_OUTPUT");
      secretScan = scan.slice(-Math.max(0, request.credential.length - 1));
    }
    output += text;
    previewPending += text;
    const tail = /[\uD800-\uDBFF]$/u.test(previewPending)
      ? previewPending.slice(-1)
      : "";
    const complete = tail ? previewPending.slice(0, -1) : previewPending;
    check(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        complete,
      ),
      "INVALID_OUTPUT",
    );
    length += encoder.encode(complete).byteLength;
    check(length <= input.outputSpec.maxBytes, "OUTPUT_SIZE_LIMIT");
    safePreview += complete;
    let boundary = Math.max(
      0,
      safePreview.length - Math.max(0, (request.credential?.length ?? 1) - 1),
    );
    if (boundary > 0 && /[\uD800-\uDBFF]/u.test(safePreview[boundary - 1]!))
      boundary--;
    emitPreview(safePreview.slice(0, boundary));
    safePreview = safePreview.slice(boundary);
    previewPending = tail;
  };
  const use = (
    u: { prompt_tokens: number; completion_tokens: number } | null | undefined,
  ) => {
    if (u) {
      usage = {
        inputTokens:
          Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0
            ? u.prompt_tokens
            : null,
        outputTokens:
          Number.isSafeInteger(u.completion_tokens) && u.completion_tokens >= 0
            ? u.completion_tokens
            : null,
      };
      request.emit?.({ type: "usage", usage });
    }
  };
  try {
    const client = transport(c, request.credential, combined);
    progress();
    request.emit?.({ type: "started" });
    if (c.stream) {
      const stream = await client.chat.completions.create(
        { ...parameters, stream: true },
        { signal: combined },
      );
      for await (const chunk of stream) {
        progress();
        check(
          Array.isArray(chunk.choices) && chunk.choices.length <= 1,
          "INVALID_OUTPUT",
        );
        use(chunk.usage);
        for (const choice of chunk.choices) {
          check(
            choice && choice.delta && typeof choice.delta === "object",
            "INVALID_OUTPUT",
          );
          check(
            !choice.delta.tool_calls?.length &&
              !(choice.delta as { function_call?: unknown }).function_call,
            "INVALID_OUTPUT",
          );
          if (choice.delta.refusal) fail("PROVIDER_REFUSED");
          if (
            choice.delta.content !== null &&
            choice.delta.content !== undefined
          )
            append(choice.delta.content);
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } else {
      const response = await client.chat.completions.create(
        { ...parameters, stream: false },
        { signal: combined },
      );
      check(
        Array.isArray(response.choices) &&
          response.choices.length === 1 &&
          response.choices[0]?.message &&
          typeof response.choices[0].message === "object",
        "INVALID_OUTPUT",
      );
      const choice = response.choices[0]!;
      check(
        !choice.message.tool_calls?.length && !choice.message.function_call,
        "INVALID_OUTPUT",
      );
      if (choice.message.refusal) fail("PROVIDER_REFUSED");
      finish = choice.finish_reason;
      if (
        choice.message.content !== null &&
        choice.message.content !== undefined
      )
        append(choice.message.content);
      use(response.usage);
    }
    check(
      finish === "stop",
      finish === "length" ? "OUTPUT_TOKEN_LIMIT" : "INVALID_OUTPUT",
    );
    validateOutput(output, input, validator);
    check(
      !request.credential || !output.includes(request.credential),
      "INVALID_OUTPUT",
    );
    emitPreview(safePreview);
    return { bytes: encoder.encode(output), usage, finishReason: "stop" };
  } catch (error) {
    throw normalizeError(error, combined);
  } finally {
    clearTimeout(idle);
  }
}
export async function discoverModels(
  c: AiResolvedConfig,
  credential: string | null,
  callerSignal: AbortSignal,
): Promise<string[]> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(15000)]);
  try {
    const page = await transport(c, credential, signal, 15000).models.list({
      signal,
    });
    check(
      Array.isArray(page.data) && page.data.length <= 1000,
      "INVALID_OUTPUT",
    );
    // Do not auto-paginate or infer capabilities from model identity.
    return [
      ...new Set(
        page.data
          .map((m) => m.id)
          .filter(
            (id) =>
              typeof id === "string" &&
              id.length <= 256 &&
              !/[\u0000-\u001f]/u.test(id),
          ),
      ),
    ];
  } catch (error) {
    throw normalizeError(error, signal, "discovery");
  }
}
export const unavailableSearch = () => ({
  available: false as const,
  entries: [],
  reason: "CAPABILITY_UNAVAILABLE",
});
export class FakeTransport {
  calls = 0;
  private readonly output: string;
  private readonly error: string | undefined;
  constructor(output: string, error?: string) {
    this.output = output;
    this.error = error;
  }
  async generate(request: RuntimeRequest): Promise<RuntimeResult> {
    const { validator } = await validateRequest(request);
    this.calls++;
    if (this.error) fail(this.error);
    if (request.signal.aborted) throw normalizeError(null, request.signal);
    const bytes = encoder.encode(this.output);
    validateOutput(this.output, request.input, validator);
    check(
      !request.credential || !this.output.includes(request.credential),
      "INVALID_OUTPUT",
    );
    return { bytes, usage: null, finishReason: "stop" };
  }
}
