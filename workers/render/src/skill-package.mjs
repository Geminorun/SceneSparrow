import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const skillPackage = Object.freeze({
  name: "remotion-best-practices",
  version: "4.0.547",
  revision: "a3f4098a2afd0e13f6a6f8c8760e275f75457ea9",
  sha256: "4845ab7cf1bda2784c6a2d71cb3c9653ca9ce276677c80e59757749e0a0d2362",
});
export const distributionUrl = `https://codeload.github.com/remotion-dev/skills/tar.gz/${skillPackage.revision}`;

// Extract only regular files from the exact official bundle, never archive links or paths.
export function unpackSkill(archive) {
  if (
    archive.length > 2 * 1024 * 1024 ||
    createHash("sha256").update(archive).digest("hex") !== skillPackage.sha256
  )
    throw Error("VIDEO_SKILL_INVALID");
  const tar = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 });
  const prefix = `skills-${skillPackage.revision}/skills/${skillPackage.name}/`;
  const files = new Map();
  for (let position = 0; position + 512 <= tar.length;) {
    const header = tar.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = field(345, 155)
      ? `${field(345, 155)}/${field(0, 100)}`
      : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim(), 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      position + 512 + size > tar.length
    )
      throw Error("VIDEO_SKILL_INVALID");
    if (name.startsWith(prefix) && !name.endsWith("/")) {
      const path = name.slice(prefix.length);
      if (
        !["0", "\0"].includes(String.fromCharCode(header[156])) ||
        path
          .split("/")
          .some(
            (part) =>
              !part || part === "." || part === ".." || part.includes("\\"),
          ) ||
        files.has(path)
      )
        throw Error("VIDEO_SKILL_INVALID");
      files.set(path, tar.subarray(position + 512, position + 512 + size));
    }
    position += 512 + Math.ceil(size / 512) * 512;
  }
  if (
    !files.has("SKILL.md") ||
    !files.has("remotion-create/REFERENCE.md") ||
    !files
      .get("SKILL.md")
      .toString()
      .includes(`version: ${skillPackage.version}`)
  )
    throw Error("VIDEO_SKILL_INVALID");
  return files;
}
