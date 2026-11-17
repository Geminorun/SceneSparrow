import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Validate the locator before spawning. Key material is never returned or logged.
export async function validateMasterKeyFile(path) {
  let file;
  const bytes = Buffer.alloc(129);
  try {
    if (typeof path !== "string" || !path) throw Error();
    file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 128 ||
      (process.platform !== "win32" && info.mode & 0o022)
    )
      throw Error();
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 128) throw Error();
    const encoded = bytes
      .subarray(0, size)
      .toString("utf8")
      .replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
    const decoded = Buffer.from(encoded, "base64");
    try {
      if (decoded.length !== 32 || decoded.toString("base64") !== encoded)
        throw Error();
    } finally {
      decoded.fill(0);
    }
  } catch {
    throw Error("AI credential configuration unavailable");
  } finally {
    bytes.fill(0);
    await file?.close();
  }
}
