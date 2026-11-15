import { readFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serialize } from "./export.mjs";
let input = "";
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw Error();
  }
  const request = JSON.parse(input);
  if (
    request.version !== 1 ||
    !["txt", "md", "docx"].includes(request.format) ||
    typeof request.input !== "string" ||
    typeof request.output !== "string"
  )
    throw Error();
  const inputBytes = await readFile(request.input);
  if (
    createHash("sha256").update(inputBytes).digest("hex") !==
    request.expectedHash
  )
    throw Error("EXPORT_INVALID");
  const snapshot = JSON.parse(inputBytes.toString("utf8"));
  const bytes = await serialize(snapshot, request.format);
  if (!bytes.length || bytes.length > 32 * 1024 * 1024)
    throw Error("EXPORT_TOO_LARGE");
  const file = await open(request.output, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  process.stdout.write(
    JSON.stringify({
      version: 1,
      attempt: request.attempt,
      size: bytes.length,
    }),
  );
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      error: [
        "EXPORT_INVALID",
        "EXPORT_TOO_LARGE",
        "EXPORT_FORMAT_UNSUPPORTED",
      ].includes(e.message)
        ? e.message
        : "EXPORT_FAILED",
    }),
  );
  process.exitCode = 1;
}
