import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import { apply as applySkillTool } from "@deepseek-ai/dsh-tool-skill";
import { unpackSkill, skillPackage } from "./skill-package.mjs";

export const template = fileURLToPath(new URL("../template/", import.meta.url));
export function validateComposition(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !== "accent,background,direction,title" ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    [...value.title].length > 80 ||
    /[\u0000-\u001f]/u.test(value.title) ||
    !/^#[0-9a-fA-F]{6}$/.test(value.background) ||
    !/^#[0-9a-fA-F]{6}$/.test(value.accent) ||
    !["left", "right"].includes(value.direction)
  )
    throw Error("VIDEO_COMPOSITION_INVALID");
  return value;
}
export async function snapshot(directory, composition) {
  validateComposition(composition);
  await mkdir(directory, { recursive: false });
  for (const path of [
    "package.json",
    "tsconfig.json",
    "README.md",
    "src/index.ts",
    "src/Root.tsx",
    "src/MotionSample.tsx",
    "public/sparrow.svg",
  ]) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(template, path), join(directory, path), {
      force: false,
      errorOnExist: true,
    });
  }
  const archive = await readFile(
    new URL("../.assets/remotion-skill.tgz", import.meta.url),
  ).catch(() => {
    throw Error("VIDEO_SKILL_UNAVAILABLE");
  });
  const skillRoot = join(directory, ".agents/skills", skillPackage.name);
  for (const [path, bytes] of unpackSkill(archive)) {
    const target = join(skillRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  await writeFile(
    join(directory, "composition.json"),
    JSON.stringify(composition, null, 2) + "\n",
  );
  await writeFile(
    join(directory, "skill-lock.json"),
    JSON.stringify(skillPackage, null, 2) + "\n",
  );
}
async function containedFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.isSymbolicLink() ||
      !(await realpath(path)).startsWith(root + sep)
    )
      throw Error("VIDEO_SKILL_INVALID");
    if (entry.isDirectory()) files.push(...(await containedFiles(path, root)));
    else if (entry.isFile()) files.push(relative(root, path));
    else throw Error("VIDEO_SKILL_INVALID");
    if (files.length > 256) throw Error("VIDEO_SKILL_INVALID");
  }
  return files;
}
export async function loadProjectSkill(directory) {
  directory = await realpath(directory);
  const root = join(directory, ".agents/skills");
  if ((await lstat(root)).isSymbolicLink()) throw Error("VIDEO_SKILL_INVALID");
  await containedFiles(root);
  const provider = new FileSystemSkillProvider(
    {
      get() {},
      logger: {
        warn() {
          throw Error("VIDEO_SKILL_INVALID");
        },
      },
    },
    { signal: new AbortController().signal, invalidate() {} },
    { includeDefaultRoots: false, customSkillDirs: [root], watch: false },
  );
  try {
    let tool;
    const candidates = await provider.list({ cwd: directory });
    if (
      !Array.isArray(candidates) ||
      candidates.length !== 1 ||
      candidates[0].name !== skillPackage.name
    )
      throw Error("VIDEO_SKILL_INVALID");
    const candidate = candidates[0];
    // Host only the native skill capability; no shell, mutation or user-wide discovery service.
    applySkillTool({
      tools: {
        register(value) {
          tool = value;
        },
      },
      skills: {
        async list() {
          return candidates;
        },
        async get(name) {
          return name === candidate.name
            ? provider.get(candidate, { cwd: directory })
            : undefined;
        },
      },
      workingDirectory: {
        async ensure() {
          return directory;
        },
      },
      on() {},
    });
    const loaded = await tool.execute(
      { name: skillPackage.name },
      { agent: {}, signal: new AbortController().signal },
    );
    const base = await realpath(loaded.resourceBase.path);
    if (base !== resolve(root, skillPackage.name))
      throw Error("VIDEO_SKILL_INVALID");
    const reference = await readFile(
      join(base, "remotion-create/REFERENCE.md"),
      "utf8",
    );
    return { skill: skillPackage, content: loaded.content, reference };
  } finally {
    await provider.dispose();
  }
}
