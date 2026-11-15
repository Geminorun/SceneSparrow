import { readFile } from "node:fs/promises";
import { parse, ParseError } from "./parser.mjs";
// The supervisor supplies a single versioned request through stdin and a trusted
// immutable object path. Workers have no database connection or mutation API.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16384) process.exit(2);
}
try {
  const request = JSON.parse(input);
  if (
    Object.keys(request).some(
      (k) => !["version", "attempt", "path", "name"].includes(k),
    ) ||
    request.version !== 1 ||
    typeof request.path !== "string" ||
    typeof request.name !== "string" ||
    typeof request.attempt !== "number"
  )
    throw new ParseError("INVALID_REQUEST");
  const result = await parse(await readFile(request.path), request.name);
  process.stdout.write(
    JSON.stringify({ version: 1, attempt: request.attempt, result }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      error: error instanceof ParseError ? error.code : "DOCUMENT_PARSE_FAILED",
    }),
  );
}
