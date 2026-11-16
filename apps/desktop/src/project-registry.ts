import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface Entry {
  id: string;
  directory: string;
  projectId: string | null;
  title: string | null;
}
interface RegistryData {
  version: 1;
  lastId: string;
  entries: Entry[];
}
export interface RecentProject {
  id: string;
  title: string;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

/** Flush a same-directory temporary file before replacing the last good registry. */
export async function writeRegistryAtomically(
  path: string,
  data: string,
  replace = rename,
) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await replace(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export class ProjectRegistry {
  private data: RegistryData | null = null;
  private queue: Promise<void> = Promise.resolve();
  status: "missing" | "ready" | "corrupt" = "missing";
  constructor(
    readonly path: string,
    private write = writeRegistryAtomically,
  ) {}
  async load() {
    try {
      const file = await open(this.path, "r");
      let value: unknown;
      try {
        if ((await file.stat()).size > 128 * 1024)
          throw Error("REGISTRY_INVALID");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      const data = value as RegistryData;
      if (
        data?.version !== 1 ||
        !validId(data.lastId) ||
        !Array.isArray(data.entries) ||
        data.entries.length > 10 ||
        !data.entries.length ||
        !data.entries.every(
          (e) =>
            e &&
            validId(e.id) &&
            typeof e.directory === "string" &&
            isAbsolute(e.directory) &&
            !e.directory.includes("\0") &&
            (e.projectId === null || typeof e.projectId === "string") &&
            (e.title === null ||
              (typeof e.title === "string" &&
                e.title.length > 0 &&
                e.title.length <= 480)),
        ) ||
        new Set(data.entries.map((e) => e.id)).size !== data.entries.length ||
        new Set(data.entries.map((e) => resolve(e.directory))).size !==
          data.entries.length ||
        !data.entries.some((e) => e.id === data.lastId)
      )
        throw Error("REGISTRY_INVALID");
      this.data = {
        version: 1,
        lastId: data.lastId,
        entries: data.entries.map(({ id, directory, projectId, title }) => ({
          id,
          directory: resolve(directory),
          projectId,
          title,
        })),
      };
      this.status = "ready";
    } catch (error) {
      this.data = null;
      this.status =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "corrupt";
    }
  }
  get lastDirectory() {
    return this.data?.entries.find((e) => e.id === this.data?.lastId)
      ?.directory;
  }
  hasDirectory(directory: string) {
    return (
      this.data?.entries.some((e) => e.directory === resolve(directory)) ??
      false
    );
  }
  recentProjects(): RecentProject[] {
    return (this.data?.entries ?? []).flatMap((e) =>
      e.title === null ? [] : [{ id: e.id, title: e.title }],
    );
  }
  resolveRecent(id: unknown): string {
    if (!validId(id)) throw Error("INVALID_REQUEST");
    const entry = this.data?.entries.find(
      (e) => e.id === id && e.title !== null,
    );
    if (!entry) throw Error("PROJECT_NOT_FOUND");
    return entry.directory;
  }
  /** Call only after activation; metadata is disposable and never owns project content. */
  record(directory: string, project: { id: string; title: string } | null) {
    const operation = this.queue.then(async () => {
      directory = resolve(directory);
      const old = this.data?.entries.find((e) => e.directory === directory);
      const entry: Entry = {
        id: old?.id ?? randomUUID(),
        directory,
        projectId: project?.id ?? null,
        title: project?.title ?? null,
      };
      const next: RegistryData = {
        version: 1,
        lastId: entry.id,
        entries: [
          entry,
          ...(this.data?.entries ?? []).filter(
            (e) => e.directory !== directory,
          ),
        ].slice(0, 10),
      };
      if (JSON.stringify(next) === JSON.stringify(this.data)) return;
      // Preserve unreadable/unsupported configuration after an explicit successful choice.
      if (this.status === "corrupt") {
        await copyFile(
          this.path,
          `${this.path}.corrupt-${randomUUID()}`,
          constants.COPYFILE_EXCL,
        );
      }
      await this.write(this.path, `${JSON.stringify(next)}\n`);
      this.data = next;
      this.status = "ready";
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

/** Existing locators must contain a database: inspection also accepts empty new folders. */
export async function inspectRememberedProject(
  directory: string,
  inspect: (directory: string) => Promise<void>,
) {
  if (
    !(await lstat(directory)).isDirectory() ||
    !(await lstat(join(directory, "project.sqlite"))).isFile()
  )
    throw Error("PROJECT_INTEGRITY_FAILED");
  await inspect(directory);
}

/** Only a genuinely absent first-run default/explicit override may be initialized. */
export async function prepareInitialProject(
  registry: ProjectRegistry,
  defaultDirectory: string,
  override: string | undefined,
  inspect: (directory: string) => Promise<void>,
): Promise<{ directory: string; create: boolean }> {
  if (!override && registry.status === "corrupt")
    throw Error("REGISTRY_INVALID");
  const directory = resolve(
    override ?? registry.lastDirectory ?? defaultDirectory,
  );
  if (
    (!override && registry.lastDirectory) ||
    registry.hasDirectory(directory)
  ) {
    await inspectRememberedProject(directory, inspect);
    return { directory, create: false };
  }
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { directory, create: true };
  }
  await inspect(directory);
  return { directory, create: false };
}
