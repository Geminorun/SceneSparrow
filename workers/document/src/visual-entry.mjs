import { readFile } from "node:fs/promises";
import { prepareVisual } from "./visual.mjs";
import { ParseError } from "./parser.mjs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 16384) process.exit(2);
}
try {
  const request = JSON.parse(input);
  if (
    request.version !== 1 ||
    typeof request.path !== "string" ||
    typeof request.name !== "string" ||
    Object.keys(request).some(
      (k) => !["version", "path", "name", "index"].includes(k),
    )
  )
    throw new ParseError("INVALID_REQUEST");
  process.stdout.write(
    JSON.stringify({
      version: 1,
      result: await prepareVisual(
        await readFile(request.path),
        request.name,
        request.index,
      ),
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      error: error instanceof ParseError ? error.code : "DOCUMENT_PARSE_FAILED",
    }),
  );
}
