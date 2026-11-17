import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Intake } from "@scenesparrow/contracts";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
export interface SelectedFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  root: string;
}
/** Only the trusted picker/main process supplies a path. The renderer receives a receipt. */
export async function intakeSelectedFile(
  path: string,
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
  progress?: (loaded: number, total: number) => void,
  identity?: SelectedFileIdentity,
): Promise<Intake> {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const id = randomUUID();
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw Error("INPUT_TOO_LARGE");
    async function verifyIdentity() {
      if (!identity) return;
      const now = await file.stat();
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.dev !== now.dev ||
        current.ino !== now.ino
      )
        throw Error("REFERENCE_FILE_CHANGED");
      if (
        now.dev !== identity.dev ||
        now.ino !== identity.ino ||
        now.size !== identity.size ||
        now.mtimeMs !== identity.mtimeMs
      )
        throw Error("REFERENCE_FILE_CHANGED");
      const tail = relative(identity.root, await realpath(path));
      if (isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`))
        throw Error("REFERENCE_FILE_CHANGED");
      let ancestor = identity.root;
      if (!(await lstat(ancestor)).isDirectory())
        throw Error("REFERENCE_FILE_CHANGED");
      for (const segment of relative(identity.root, dirname(path))
        .split(sep)
        .filter(Boolean)) {
        ancestor = join(ancestor, segment);
        if (!(await lstat(ancestor)).isDirectory())
          throw Error("REFERENCE_FILE_CHANGED");
      }
    }
    await verifyIdentity();
    const stream = file.createReadStream({ autoClose: false });
    let bytes = 0;
    async function* bounded() {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > MAX_FILE_BYTES) throw Error("INPUT_TOO_LARGE");
        signal?.throwIfAborted();
        progress?.(bytes, stat.size);
        yield chunk;
      }
      await verifyIdentity();
    }
    const response = await fetch(`${baseUrl}/intakes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-intake-id": id,
        "x-file-name": encodeURIComponent(basename(path)),
        "content-type": "application/octet-stream",
      },
      body: bounded() as unknown as BodyInit,
      duplex: "half",
      signal: AbortSignal.any([
        AbortSignal.timeout(120000),
        ...(signal ? [signal] : []),
      ]),
    } as RequestInit);
    const data = await response.json();
    if (!response.ok) throw Error((data as { code: string }).code);
    return data;
  } catch (error) {
    await fetch(`${baseUrl}/intakes/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}
