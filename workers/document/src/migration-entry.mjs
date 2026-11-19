import {
  serializeMigrationMarkdown,
  migrationSerializer,
} from "../../../packages/manuscript-format/src/migration.ts";
const maxEnvelope = 32 * 1024 * 1024;
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxEnvelope) throw Error("MIGRATION_SIZE_LIMIT");
    chunks.push(chunk);
  }
  const blocks = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(blocks)) throw Error("MIGRATION_UNSUPPORTED");
  const source = serializeMigrationMarkdown(blocks);
  if (Buffer.byteLength(source) > 4 * 1024 * 1024)
    throw Error("MIGRATION_SIZE_LIMIT");
  process.stdout.write(
    JSON.stringify({ source, serializer: migrationSerializer }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error:
        error?.message === "MIGRATION_SIZE_LIMIT"
          ? "MIGRATION_SIZE_LIMIT"
          : "MIGRATION_UNSUPPORTED",
    }),
  );
  process.exitCode = 1;
}
