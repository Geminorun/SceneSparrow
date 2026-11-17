import { lstat, open, opendir, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Intake,
  ReferenceDirectoryAssociation,
  ReferenceDirectoryBatch,
} from "@scenesparrow/contracts";
import { writeRegistryAtomically } from "./project-registry.js";
import {
  intakeSelectedFile,
  type SelectedFileIdentity,
} from "./file-intake.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supported = new Set([".txt", ".md", ".markdown", ".docx", ".pdf"]);
export const REFERENCE_DIRECTORY_LIMITS = {
  files: 100,
  bytes: 100 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  examined: 2000,
  depth: 32,
} as const;

export function validReferencePath(path: string) {
  return (
    Buffer.byteLength(path, "utf8") <= 4096 &&
    !/[\p{Cc}\\:]/u.test(path) &&
    path
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function inside(root: string, path: string) {
  const tail = relative(root, path);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

async function checkedRoot(path: string) {
  if (!(await lstat(path)).isDirectory()) throw Error("INVALID_REQUEST");
  return realpath(path);
}

interface Association extends ReferenceDirectoryAssociation {
  projectId: string;
  directory: string;
}

/** Host-only paths are persisted separately from portable project data. */
export class ReferenceDirectoryRegistry {
  private entries: Association[] = [];
  private queue: Promise<void> = Promise.resolve();
  private corrupt = false;
  constructor(readonly path: string) {}
  async load() {
    try {
      const file = await open(this.path, "r");
      let value;
      try {
        if ((await file.stat()).size > 256 * 1024)
          throw Error("REGISTRY_INVALID");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      if (
        value?.version !== 1 ||
        !Array.isArray(value.entries) ||
        value.entries.length > 100 ||
        !value.entries.every(
          (e: Association) =>
            e &&
            uuid.test(e.id) &&
            uuid.test(e.projectId) &&
            typeof e.name === "string" &&
            e.name.length > 0 &&
            e.name.length <= 1024 &&
            typeof e.directory === "string" &&
            isAbsolute(e.directory) &&
            !e.directory.includes("\0"),
        ) ||
        new Set(value.entries.map((e: Association) => e.projectId)).size !==
          value.entries.length ||
        new Set(value.entries.map((e: Association) => e.id)).size !==
          value.entries.length
      )
        throw Error("REGISTRY_INVALID");
      this.entries = value.entries.map(
        ({ id, projectId, name, directory }: Association) => ({
          id,
          projectId,
          name,
          directory,
        }),
      );
    } catch (error) {
      this.entries = [];
      this.corrupt = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
  read(projectId: string): ReferenceDirectoryAssociation | null {
    if (!uuid.test(projectId)) throw Error("INVALID_REQUEST");
    const entry = this.entries.find((e) => e.projectId === projectId);
    return entry ? { id: entry.id, name: entry.name } : null;
  }
  resolve(projectId: string, id: unknown): string {
    if (!uuid.test(projectId) || typeof id !== "string" || !uuid.test(id))
      throw Error("INVALID_REQUEST");
    const entry = this.entries.find(
      (e) => e.projectId === projectId && e.id === id,
    );
    if (!entry) throw Error("OBJECT_NOT_FOUND");
    return entry.directory;
  }
  async record(
    projectId: string,
    selected: string,
  ): Promise<ReferenceDirectoryAssociation> {
    if (!uuid.test(projectId)) throw Error("INVALID_REQUEST");
    const directory = await checkedRoot(resolve(selected));
    const operation = this.queue.then(async () => {
      // Preserve corrupt host configuration for diagnosis instead of silently replacing it.
      if (this.corrupt) throw Error("REGISTRY_INVALID");
      const previous = this.entries.find(
        (e) => e.projectId === projectId && e.directory === directory,
      );
      const entry = {
        id: previous?.id ?? randomUUID(),
        projectId,
        directory,
        name: basename(directory) || directory,
      };
      const next = [
        entry,
        ...this.entries.filter((e) => e.projectId !== projectId),
      ].slice(0, 100);
      await writeRegistryAtomically(
        this.path,
        `${JSON.stringify({ version: 1, entries: next })}\n`,
      );
      this.entries = next;
      return { id: entry.id, name: entry.name };
    });
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}

export interface DirectoryIntakePort {
  upload(
    path: string,
    identity: SelectedFileIdentity,
    signal: AbortSignal,
  ): Promise<Intake>;
  cancel(id: string): Promise<unknown>;
}

/** No source commands or selection changes occur here; callers own each returned intake. */
export async function intakeReferenceDirectory(
  directory: string,
  association: ReferenceDirectoryAssociation,
  port: DirectoryIntakePort,
  signal: AbortSignal,
): Promise<ReferenceDirectoryBatch> {
  const root = await checkedRoot(directory);
  const result: ReferenceDirectoryBatch = {
    association,
    entries: [],
    outcomes: [],
    truncated: false,
  };
  let examined = 0,
    files = 0,
    bytes = 0;
  const outcome = (
    relativePath: string,
    code: string,
    status: "skipped" | "error" = "skipped",
  ) => {
    result.outcomes.push({ relativePath, code, status });
  };
  async function walk(path: string, prefix: string, depth: number) {
    signal.throwIfAborted();
    if (
      !(await lstat(path)).isDirectory() ||
      !inside(root, await realpath(path))
    ) {
      outcome(prefix, "REFERENCE_SYMLINK");
      return;
    }
    const handle = await opendir(path);
    for await (const item of handle) {
      signal.throwIfAborted();
      if (++examined > REFERENCE_DIRECTORY_LIMITS.examined) {
        result.truncated = true;
        outcome(prefix, "REFERENCE_SCAN_LIMIT");
        break;
      }
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (!validReferencePath(relativePath)) {
        outcome(relativePath, "INVALID_REQUEST");
        continue;
      }
      const filePath = join(path, item.name);
      try {
        const stat = await lstat(filePath);
        if (stat.isSymbolicLink()) {
          outcome(relativePath, "REFERENCE_SYMLINK");
          continue;
        }
        if (!inside(root, await realpath(filePath))) {
          outcome(relativePath, "REFERENCE_OUTSIDE_ROOT");
          continue;
        }
        if (stat.isDirectory()) {
          if (depth >= REFERENCE_DIRECTORY_LIMITS.depth)
            outcome(relativePath, "REFERENCE_DEPTH_LIMIT");
          else await walk(filePath, relativePath, depth + 1);
          if (result.truncated) break;
          continue;
        }
        if (
          !stat.isFile() ||
          !supported.has(extname(item.name).toLowerCase())
        ) {
          outcome(relativePath, "REFERENCE_UNSUPPORTED");
          continue;
        }
        if (stat.size > REFERENCE_DIRECTORY_LIMITS.fileBytes) {
          outcome(relativePath, "INPUT_TOO_LARGE");
          continue;
        }
        if (
          files >= REFERENCE_DIRECTORY_LIMITS.files ||
          bytes + stat.size > REFERENCE_DIRECTORY_LIMITS.bytes
        ) {
          outcome(relativePath, "REFERENCE_BATCH_LIMIT");
          result.truncated = true;
          break;
        }
        files += 1;
        bytes += stat.size;
        const intake = await port.upload(
          filePath,
          {
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            root,
          },
          signal,
        );
        result.entries.push({ intake, relativePath });
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw error;
        outcome(
          relativePath,
          error instanceof Error &&
            [
              "INPUT_TOO_LARGE",
              "INVALID_REQUEST",
              "REFERENCE_FILE_CHANGED",
            ].includes(error.message)
            ? error.message
            : "STORAGE_UNAVAILABLE",
          "error",
        );
      }
    }
  }
  try {
    await walk(root, "", 0);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    await Promise.allSettled(
      result.entries.map(({ intake }) => port.cancel(intake.id)),
    );
    throw error;
  }
}

export function directoryIntakePort(
  baseUrl: string,
  token: string,
): DirectoryIntakePort {
  return {
    upload: (path, identity, signal) =>
      intakeSelectedFile(path, baseUrl, token, signal, undefined, identity),
    cancel: (id) =>
      fetch(`${baseUrl}/intakes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      }),
  };
}
