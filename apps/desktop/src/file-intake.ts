import { open } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Only the trusted picker/main process supplies a path. The renderer receives a receipt. */
export async function intakeSelectedFile(
  path: string,
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
  progress?: (loaded: number, total: number) => void,
) {
  const file = await open(path, "r");
  const id = randomUUID();
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw Error("INPUT_TOO_LARGE");
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
