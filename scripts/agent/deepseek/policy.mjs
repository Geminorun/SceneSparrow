export const VERSION = "0.2.2-rc.5";
export const MAX_INPUT = 2 * 1024 * 1024;
export const MAX_OUTPUT = 8 * 1024 * 1024;
export const DEADLINE = 125_000;
export const SOCKET_ROOT = "/run/writing-agent";

export function credentialHandshake(message) {
  if (
    message?.protocolVersion !== 1 ||
    Object.keys(message).some(
      (key) => !["protocolVersion", "apiKey"].includes(key),
    ) ||
    !(
      message.apiKey === null ||
      (typeof message.apiKey === "string" &&
        /^[\x21-\x7e]{1,4096}$/.test(message.apiKey))
    )
  )
    throw Error("Invalid bridge handshake");
  return message.apiKey;
}

export function admit(message) {
  if (
    message?.jsonrpc !== "2.0" ||
    ![
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/prompt",
      "session/cancel",
      "session/close",
    ].includes(message.method)
  )
    return false;
  const params = message.params;
  if (message.method === "session/new")
    return (
      params?.cwd === "/tmp/writing" &&
      Array.isArray(params.mcpServers) &&
      params.mcpServers.length === 0
    );
  if (message.method === "session/prompt")
    return (
      Array.isArray(params?.prompt) &&
      params.prompt.length > 0 &&
      params.prompt.every(
        (block) => block.type === "text" && typeof block.text === "string",
      )
    );
  if (message.method === "session/set_config_option")
    return params?.configId === "model";
  return true;
}

export function redact(line, apiKey) {
  return apiKey ? line.replaceAll(apiKey, "[REDACTED]") : line;
}

export function encode(message, apiKey) {
  return JSON.stringify(message, (_name, value) =>
    typeof value === "string" ? redact(value, apiKey) : value,
  );
}
