import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  InputData,
  JSONSchemaInput,
  FetchingJSONSchemaStore,
  quicktype,
} from "quicktype-core";

const root = new URL("../", import.meta.url);
const schema = await readFile(
  new URL("packages/contracts/schema/protocol.schema.json", root),
  "utf8",
);
const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
await input.addSource({ name: "Protocol", schema });
const inputData = new InputData();
inputData.addInput(input);

for (const [lang, path, rendererOptions] of [
  [
    "typescript",
    "packages/contracts/src/generated.ts",
    { "just-types": "true" },
  ],
  [
    "rust",
    "crates/service/src/contracts.rs",
    { visibility: "public", "derive-debug": "true", "derive-clone": "true" },
  ],
]) {
  const { lines } = await quicktype({ inputData, lang, rendererOptions });
  let output =
    "// Generated from protocol.schema.json. Do not edit by hand.\n" +
    lines.join("\n").trimEnd() +
    "\n";
  if (lang === "rust") {
    // Every protocol object is closed in the schema; enforce that on input too.
    output = output.replaceAll(
      "pub struct ",
      "#[serde(deny_unknown_fields)]\npub struct ",
    );
    const formatted = spawnSync(
      "rustfmt",
      ["--edition", "2024", "--emit", "stdout"],
      { input: output, encoding: "utf8" },
    );
    if (formatted.status !== 0)
      throw new Error(formatted.stderr || "rustfmt failed");
    output = formatted.stdout;
  }
  const destination = new URL(path, root);
  if (process.argv.includes("--check")) {
    if ((await readFile(destination, "utf8")) !== output)
      throw new Error(`Generated contract is stale: ${path}`);
  } else {
    await mkdir(new URL("./", destination), { recursive: true });
    await writeFile(destination, output);
  }
  console.log(
    `${process.argv.includes("--check") ? "Checked" : "Generated"} ${fileURLToPath(destination)}`,
  );
}
