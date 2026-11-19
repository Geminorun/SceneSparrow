import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, link, unlink } from "node:fs/promises";
import { basename, dirname, join, extname } from "node:path";
export type TargetIdentity = string | null;
const ownedIdentity = (s: BigIntStats) =>
  [s.dev, s.ino, s.birthtimeNs, s.size].join(":");
const fullIdentity = (s: BigIntStats) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(":");
async function parentIdentity(path: string) {
  const s = await lstat(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || (await realpath(path)) !== path)
    throw Error("DESTINATION_CHANGED");
  return [s.dev, s.ino, s.birthtimeNs].join(":");
}
export async function targetIdentity(path: string): Promise<TargetIdentity> {
  try {
    const s = await lstat(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw Error("DESTINATION_CHANGED");
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs].join(
      ":",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function prepareDestination(path: string, format: string) {
  if (
    !["txt", "md", "docx"].includes(format) ||
    extname(path).toLowerCase() !== `.${format}`
  )
    throw Error("DESTINATION_UNAVAILABLE");
  return prepareMemberDestination(path);
}
/** Named native member downloads share destination identity checks with exports. */
export async function prepareMemberDestination(path: string) {
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch {
    throw Error("DESTINATION_UNAVAILABLE");
  }
  const name = basename(path);
  if (
    !name ||
    /[\u0000-\u001f<>:"|?*]/u.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/i.test(
      name,
    )
  )
    throw Error("DESTINATION_UNAVAILABLE");
  const canonical = join(parent, name);
  try {
    return {
      path: canonical,
      identity: await targetIdentity(canonical),
      parent: await parentIdentity(parent),
    };
  } catch (e) {
    throw Error(
      e instanceof Error && e.message === "DESTINATION_CHANGED"
        ? e.message
        : "DESTINATION_UNAVAILABLE",
    );
  }
}
export type CommitHooks = {
  beforeWrite?: () => Promise<void>;
  afterClose?: () => Promise<void>;
  beforeFinalize?: () => Promise<void>;
  finalize?: typeof rename;
  afterFinalize?: () => Promise<void>;
};
/** Only main calls this with an already scoped, dialog-authorized destination. */
export async function commitExportFile(
  target: { path: string; identity: TargetIdentity; parent: string },
  bytes: Uint8Array,
  expectedHash: string,
  hooks: CommitHooks = {},
) {
  if (
    bytes.byteLength > 32 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== expectedHash
  )
    throw Error("ARTIFACT_MISMATCH");
  const temp = join(dirname(target.path), `.scenesparrow-${randomUUID()}.tmp`);
  let finalized = false;
  let tempIdentity: TargetIdentity = null;
  const parentMatches = async () => {
    try {
      return (await parentIdentity(dirname(target.path))) === target.parent;
    } catch {
      return false;
    }
  };
  try {
    if (!(await parentMatches())) throw Error("DESTINATION_CHANGED");
    const file = await open(temp, "wx+", 0o600);
    try {
      await hooks.beforeWrite?.();
      // Bounded writes avoid one blocking pipe and verify the bytes actually stored.
      for (let offset = 0; offset < bytes.length;) {
        const result = await file.write(bytes.subarray(offset, offset + 65536));
        if (!result.bytesWritten) throw Error("DESTINATION_UNAVAILABLE");
        offset += result.bytesWritten;
      }
      await file.sync();
    } finally {
      // Windows may publish LastWriteTime only when the writable handle closes.
      // Pin native identity/size, then establish the full timestamp stamp after close.
      const owned = await file.stat({ bigint: true }).catch(() => null);
      await file.close();
      if (owned && (await parentMatches())) {
        const closed = await lstat(temp, { bigint: true }).catch(() => null);
        if (
          closed?.isFile() &&
          !closed.isSymbolicLink() &&
          ownedIdentity(closed) === ownedIdentity(owned)
        )
          tempIdentity = fullIdentity(closed);
      }
    }
    await hooks.afterClose?.();
    if (!(await parentMatches()) || tempIdentity === null)
      throw Error("DESTINATION_CHANGED");
    const beforeRead = await lstat(temp, { bigint: true });
    const stableOwner = tempIdentity.split(":");
    if (
      !beforeRead.isFile() ||
      beforeRead.isSymbolicLink() ||
      [
        beforeRead.dev,
        beforeRead.ino,
        beforeRead.size,
        beforeRead.birthtimeNs,
      ].join(":") !==
        [stableOwner[0], stableOwner[1], stableOwner[2], stableOwner[5]].join(
          ":",
        )
    )
      throw Error("DESTINATION_CHANGED");
    const verified = await open(
      temp,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const handle = await verified.stat({ bigint: true });
      if (
        ownedIdentity(handle) !== ownedIdentity(beforeRead) ||
        handle.size !== BigInt(bytes.length)
      )
        throw Error("DESTINATION_CHANGED");
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      for (let position = 0; position < bytes.length;) {
        const { bytesRead } = await verified.read(
          buffer,
          0,
          Math.min(buffer.length, bytes.length - position),
          position,
        );
        if (!bytesRead) throw Error("DESTINATION_CHANGED");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (hash.digest("hex") !== expectedHash)
        throw Error("DESTINATION_CHANGED");
      tempIdentity = fullIdentity(await verified.stat({ bigint: true }));
    } finally {
      await verified.close();
    }
    await hooks.beforeFinalize?.();
    if (
      tempIdentity === null ||
      (await targetIdentity(temp).catch(() => null)) !== tempIdentity
    )
      throw Error("DESTINATION_CHANGED");
    if (
      !(await parentMatches()) ||
      (await targetIdentity(target.path)) !== target.identity
    )
      throw Error("DESTINATION_CHANGED");
    if (target.identity === null) {
      // Exclusive creation prevents an absent target becoming a silent overwrite.
      await link(temp, target.path);
      finalized = true;
      await unlink(temp);
    } else {
      await (hooks.finalize ?? rename)(temp, target.path);
      finalized = true;
    }
    if (process.platform !== "win32") {
      const parent = await open(dirname(target.path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    await hooks.afterFinalize?.();
  } catch (e) {
    if (finalized) throw Error("DELIVERY_STATUS_UNKNOWN");
    if (
      e instanceof Error &&
      ["DESTINATION_CHANGED", "ARTIFACT_MISMATCH"].includes(e.message)
    )
      throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw Error(
      code === "EEXIST"
        ? "DESTINATION_CHANGED"
        : ["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
          ? "DESTINATION_LOCKED"
          : "DESTINATION_UNAVAILABLE",
    );
  } finally {
    // A replaced parent must never redirect cleanup into somebody else's directory.
    if (
      (await parentMatches()) &&
      tempIdentity !== null &&
      (await targetIdentity(temp).catch(() => null)) === tempIdentity
    )
      await unlink(temp).catch(() => {});
  }
}
export function suggestedExportName(title: string, format: string) {
  let clean = title
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/gu, "")
    .trim()
    .replace(/[. ]+$/u, "");
  if (
    !clean ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/i.test(
      clean,
    )
  )
    clean = "manuscript";
  let result = "";
  for (const { segment } of new Intl.Segmenter("en", {
    granularity: "grapheme",
  }).segment(clean)) {
    if (
      (result + segment).length > 120 ||
      Buffer.byteLength(result + segment) > 180
    )
      break;
    result += segment;
  }
  result = result.replace(/[. ]+$/u, "");
  if (
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/i.test(
      result,
    )
  )
    result = "manuscript";
  return `${result || "manuscript"}.${format}`;
}

/** Fixed-buffer attachment delivery keeps the held temporary file identity and
 * verifies its disk bytes before publishing the dialog-authorized destination. */
export async function commitMemberStream(
  target: Awaited<ReturnType<typeof prepareMemberDestination>>,
  input: AsyncIterable<Uint8Array>,
  expectedHash: string,
  guard: () => void,
  hooks: CommitHooks = {},
) {
  const temp = join(
    dirname(target.path),
    `.scenesparrow-member-${randomUUID()}.tmp`,
  );
  const parentMatches = async () => {
    try {
      return (await parentIdentity(dirname(target.path))) === target.parent;
    } catch {
      return false;
    }
  };
  let tempIdentity: TargetIdentity = null,
    finalized = false;
  try {
    guard();
    if (!(await parentMatches())) throw Error("DESTINATION_CHANGED");
    guard();
    const file = await open(temp, "wx+", 0o600);
    let total = 0;
    try {
      guard();
      await hooks.beforeWrite?.();
      guard();
      const digest = createHash("sha256");
      for await (const chunk of input) {
        guard();
        total += chunk.length;
        if (total > 4 * 1024 * 1024 * 1024) throw Error("ARTIFACT_MISMATCH");
        digest.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const result = await file.write(
            chunk.subarray(offset, offset + 65536),
          );
          guard();
          if (!result.bytesWritten) throw Error("DESTINATION_UNAVAILABLE");
          offset += result.bytesWritten;
        }
      }
      await file.sync();
      guard();
      if (digest.digest("hex") !== expectedHash)
        throw Error("ARTIFACT_MISMATCH");
      const before = await file.stat({ bigint: true });
      guard();
      const actual = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      for (let position = 0; position < total;) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, total - position),
          position,
        );
        guard();
        if (!bytesRead) throw Error("DESTINATION_CHANGED");
        actual.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      guard();
      if (
        fullIdentity(before) !== fullIdentity(after) ||
        after.size !== BigInt(total) ||
        actual.digest("hex") !== expectedHash
      )
        throw Error("DESTINATION_CHANGED");
    } finally {
      const owned = await file.stat({ bigint: true }).catch(() => null);
      await file.close();
      if (owned && (await parentMatches())) {
        const closed = await lstat(temp, { bigint: true }).catch(() => null);
        if (
          closed?.isFile() &&
          !closed.isSymbolicLink() &&
          ownedIdentity(closed) === ownedIdentity(owned)
        )
          tempIdentity = fullIdentity(closed);
      }
    }
    await hooks.afterClose?.();
    guard();
    await hooks.beforeFinalize?.();
    guard();
    if (
      tempIdentity === null ||
      (await targetIdentity(temp)) !== tempIdentity ||
      !(await parentMatches()) ||
      (await targetIdentity(target.path)) !== target.identity
    )
      throw Error("DESTINATION_CHANGED");
    guard();
    if (target.identity === null) {
      await link(temp, target.path);
      finalized = true;
      await unlink(temp);
    } else {
      await (hooks.finalize ?? rename)(temp, target.path);
      finalized = true;
    }
    if (process.platform !== "win32") {
      const parent = await open(dirname(target.path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    await hooks.afterFinalize?.();
    guard();
  } catch (error) {
    if (finalized) throw Error("DELIVERY_STATUS_UNKNOWN");
    if (
      error instanceof Error &&
      [
        "DESTINATION_CHANGED",
        "ARTIFACT_MISMATCH",
        "CAPABILITY_EXPIRED",
        "PROJECT_CLOSING",
        "ORIGIN_DENIED",
      ].includes(error.message)
    )
      throw error;
    throw Error(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "DESTINATION_CHANGED"
        : "DESTINATION_UNAVAILABLE",
    );
  } finally {
    if (
      (await parentMatches()) &&
      tempIdentity !== null &&
      (await targetIdentity(temp).catch(() => null)) === tempIdentity
    )
      await unlink(temp).catch(() => {});
  }
}
