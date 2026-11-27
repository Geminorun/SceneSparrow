import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { distributionUrl, unpackSkill } from "./skill-package.mjs";

const target = fileURLToPath(
  new URL("../.assets/remotion-skill.tgz", import.meta.url),
);
const source = process.env.SCENESPARROW_REMOTION_SKILL_ARCHIVE;
let archive;
if (source) archive = await readFile(source);
else {
  const response = await fetch(distributionUrl, {
    signal: AbortSignal.timeout(30000),
  });
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > 2 * 1024 * 1024
  )
    throw Error("VIDEO_SKILL_UNAVAILABLE");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error("VIDEO_SKILL_INVALID");
    chunks.push(chunk);
  }
  archive = Buffer.concat(chunks);
}
const files = unpackSkill(archive);
await mkdir(dirname(target), { recursive: true });
const pending = join(dirname(target), `skill-${process.pid}.tmp`);
try {
  await writeFile(pending, archive, { flag: "wx" });
  await rename(pending, target);
} finally {
  await rm(pending, { force: true });
}
console.log(
  `Prepared official Remotion skill (${files.size} files); verified pinned SHA-256.`,
);
