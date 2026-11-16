import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const crates = ["application", "domain", "infrastructure", "service"];
export async function versionFiles(root = process.cwd()) {
  const files = ["package.json"];
  for (const directory of ["apps", "packages", "workers"])
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    }))
      if (entry.isDirectory())
        files.push(`${directory}/${entry.name}/package.json`);
  return files;
}
export async function applicationVersion(root = process.cwd()) {
  let version;
  for (const file of await versionFiles(root)) {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"));
    if (manifest.private !== true || !stableVersion.test(manifest.version))
      throw Error("Invalid private workspace version");
    version ??= manifest.version;
    if (version !== manifest.version) throw Error("Workspace versions differ");
  }
  const cargo = await readFile(join(root, "Cargo.toml"), "utf8");
  if (!cargo.includes(`[workspace.package]\nversion = "${version}"`))
    throw Error("Cargo workspace version differs");
  const lock = await readFile(join(root, "Cargo.lock"), "utf8");
  for (const crate of crates)
    if (
      !lock.includes(`name = "scenesparrow-${crate}"\nversion = "${version}"`)
    )
      throw Error("Cargo lock workspace version differs");
  return version;
}
export async function setVersion(version, root = process.cwd()) {
  if (!stableVersion.test(version ?? ""))
    throw Error("Use MAJOR.MINOR.PATCH without leading zeroes");
  await applicationVersion(root);
  const changes = [];
  for (const file of await versionFiles(root)) {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"));
    manifest.version = version;
    changes.push([file, JSON.stringify(manifest, null, 2) + "\n"]);
  }
  changes.push([
    "Cargo.toml",
    (await readFile(join(root, "Cargo.toml"), "utf8")).replace(
      /(\[workspace.package\]\nversion = ")[^"]+/,
      `$1${version}`,
    ),
  ]);
  let lock = await readFile(join(root, "Cargo.lock"), "utf8");
  for (const crate of crates)
    lock = lock.replace(
      new RegExp(`(name = "scenesparrow-${crate}"\\nversion = ")[^"]+`),
      `$1${version}`,
    );
  changes.push(["Cargo.lock", lock]);
  for (const [file, contents] of changes)
    await writeFile(join(root, file), contents);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 3)
    throw Error("Usage: pnpm release:version MAJOR.MINOR.PATCH");
  await setVersion(process.argv[2]);
  console.log("Application workspace version synchronized");
}
