import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const schema = JSON.parse(
  await readFile(
    new URL("packages/contracts/schema/protocol.schema.json", root),
    "utf8",
  ),
);
Object.assign(
  schema.definitions,
  JSON.parse(
    await readFile(
      new URL("packages/contracts/schema/ai.schema.json", root),
      "utf8",
    ),
  ).definitions,
);
const diagnosticSchema = JSON.parse(
  await readFile(
    new URL("packages/contracts/schema/diagnostics.schema.json", root),
    "utf8",
  ),
);
Object.assign(schema.definitions, diagnosticSchema.definitions);
const fileSchema = JSON.parse(
  await readFile(
    new URL("packages/contracts/schema/open-project.schema.json", root),
    "utf8",
  ),
);
Object.assign(schema.definitions, fileSchema.definitions);
// This generator deliberately supports the protocol subset used here. Constraint
// validation remains in the core; unsupported type constructs fail generation.
function validateShape(s) {
  // Only these two named file-format definitions admit opaque JSON. Live DTOs
  // remain closed; adding an open transport object still fails generation.
  if (s === schema.definitions.FileJsonValue) {
    if (Object.keys(s).length)
      throw Error("FileJsonValue must be the unconstrained JSON schema");
    return;
  }
  if (s === schema.definitions.FileExtensions) {
    if (
      s.type !== "object" ||
      Object.keys(s).length !== 2 ||
      s.additionalProperties?.$ref !== "#/definitions/FileJsonValue" ||
      s.properties
    )
      throw Error("Invalid file extension map");
    return;
  }
  const allowed = new Set([
    "$schema",
    "title",
    "type",
    "additionalProperties",
    "required",
    "properties",
    "definitions",
    "$ref",
    "oneOf",
    "anyOf",
    "enum",
    "items",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
  ]);
  for (const key of Object.keys(s))
    if (!allowed.has(key)) throw Error(`Unsupported schema keyword: ${key}`);
  if (s.$ref && !schema.definitions[s.$ref.split("/").at(-1)])
    throw Error(`Unknown reference: ${s.$ref}`);
  if (
    Array.isArray(s.type) &&
    (s.type.length !== 2 || !s.type.includes("null"))
  )
    throw Error("Only nullable type unions are supported");
  if (s.type === "object" && s.additionalProperties !== false)
    throw Error("Protocol objects must be closed");
  if (
    s.anyOf &&
    (s.anyOf.length !== 2 ||
      s.anyOf.filter((v) => v.type === "null").length !== 1)
  )
    throw Error("Only nullable anyOf is supported");
  for (const child of [
    ...Object.values(s.properties ?? {}),
    ...Object.values(s.definitions ?? {}),
    ...(s.oneOf ?? []),
    ...(s.anyOf ?? []),
    ...(s.items ? [s.items] : []),
  ])
    validateShape(child);
}
validateShape(schema);
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const pascal = (s) => s[0].toUpperCase() + s.slice(1);
function ts(s) {
  if (s === schema.definitions.FileJsonValue)
    return "null | boolean | number | string | FileJsonValue[] | { [key: string]: FileJsonValue }";
  if (s === schema.definitions.FileExtensions)
    return "Record<string, FileJsonValue>";
  if (s.$ref) return s.$ref.split("/").at(-1);
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf).map(ts).join(" | ");
  if (s.enum) return s.enum.map(JSON.stringify).join(" | ");
  if (Array.isArray(s.type))
    return s.type.map((type) => ts({ type })).join(" | ");
  if (s.type === "object")
    return `{ ${Object.entries(s.properties ?? {})
      .map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${ts(v)};`)
      .join(" ")} }`;
  if (s.type === "array") return `Array<${ts(s.items)}>`;
  const type = {
    string: "string",
    integer: "number",
    boolean: "boolean",
    null: "null",
  }[s.type];
  if (!type) throw Error(`Unsupported TypeScript schema: ${JSON.stringify(s)}`);
  return type;
}
const declarations = [];
const serviceDeclarations = [];
const transportNames = new Set([
  "Project",
  "Health",
  "CreateProject",
  "EnsureProject",
  "RenameProject",
  "ProjectResponse",
  "ApiError",
]);
function rust(s, name) {
  if (
    s === schema.definitions.FileJsonValue ||
    s === schema.definitions.FileExtensions
  ) {
    declarations.push(
      `pub type ${name} = ${name === "FileJsonValue" ? "serde_json::Value" : "std::collections::BTreeMap<String, FileJsonValue>"};`,
    );
    return name;
  }
  if (s.$ref) return s.$ref.split("/").at(-1);
  if (s.oneOf) {
    const tag = Object.keys(s.oneOf[0].properties).find((k) =>
      s.oneOf.every((v) => v.properties[k]?.enum?.length === 1),
    );
    if (!tag) throw Error(`Union needs discriminator: ${name}`);
    const variants = s.oneOf.map((v) => {
      const props = { ...v.properties };
      const value = props[tag].enum[0];
      delete props[tag];
      return `#[serde(rename = ${JSON.stringify(value)})]\n${pascal(value).replace(/_([a-z])/g, (_, c) => c.toUpperCase())} { ${fields({ ...v, properties: props }, name, false)} }`;
    });
    declarations.push(
      `#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(tag = "${tag}", deny_unknown_fields)]\npub enum ${name} { ${variants.join(",\n")} }`,
    );
    return name;
  }
  if (s.anyOf) {
    const nonnull = s.anyOf.filter((v) => v.type !== "null");
    if (nonnull.length !== 1) throw Error(name);
    return `Option<${rust(nonnull[0], name)}>`;
  }
  if (Array.isArray(s.type))
    return `Option<${rust({ ...s, type: s.type.find((t) => t !== "null"), enum: s.enum?.filter((v) => v !== null) }, name)}>`;
  if (s.enum && s.type === "string") {
    declarations.push(
      `#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]\npub enum ${name} { ${s.enum.map((v) => `#[serde(rename = ${JSON.stringify(v)})] ${pascal(v).replace(/[^a-zA-Z0-9]/g, "")}`).join(",")} }`,
    );
    return name;
  }
  if (s.type === "object") {
    const body = fields(s, name);
    declarations.push(
      `#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct ${name} { ${body} }`,
    );
    return name;
  }
  if (s.type === "array") return `Vec<${rust(s.items, name + "Item")}>`;
  const type = { string: "String", integer: "i64", boolean: "bool" }[s.type];
  if (!type) throw Error(`Unsupported Rust schema: ${name}`);
  return type;
}
function fields(s, name, visibility = true) {
  return Object.entries(s.properties ?? {})
    .map(([k, v]) => {
      let type = rust(v, name + pascal(k));
      // Keep the large immutable snapshot indirect in the framed control union.
      if (name === "AiWorkerControl" && k === "configuration")
        type = `Box<${type}>`;
      if (!s.required?.includes(k)) type = `Option<${type}>`;
      const optional = !s.required?.includes(k);
      const field = k === "type" ? "r#type" : snake(k);
      return `#[serde(rename = ${JSON.stringify(k)}${optional ? ', default, skip_serializing_if = "Option::is_none", deserialize_with = "present_nonnull"' : type.startsWith("Option<") ? ', deserialize_with = "required_nullable"' : ""})] ${visibility ? "pub " : ""}${field}: ${type}`;
    })
    .join(",\n");
}
for (const [name, s] of Object.entries(schema.definitions)) {
  const start = declarations.length;
  rust(s, name);
  if (transportNames.has(name) || name.startsWith("Diagnostic"))
    serviceDeclarations.push(...declarations.splice(start));
}
const banner = "// Generated from protocol.schema.json. Do not edit by hand.\n";
const helper = `fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> { Option::<T>::deserialize(deserializer) }\n#[allow(dead_code)]\nfn present_nonnull<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> { T::deserialize(deserializer).map(Some) }\n`;
const outputs = [
  [
    "packages/contracts/src/generated.ts",
    banner +
      Object.entries(schema.definitions)
        .map(([name, s]) => `export type ${name} = ${ts(s)};`)
        .join("\n") +
      "\n",
  ],
  [
    "crates/domain/src/contracts.rs",
    banner +
      "use serde::{Deserialize, Serialize};\n" +
      helper +
      declarations.join("\n") +
      "\n",
  ],
  [
    "crates/service/src/contracts.rs",
    banner +
      "pub use scenesparrow_domain::contracts::*;\nuse serde::{Deserialize, Serialize};\n" +
      helper +
      serviceDeclarations.join("\n") +
      "\n",
  ],
];
for (let [path, output] of outputs) {
  if (path.endsWith(".rs")) {
    const r = spawnSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], {
      input: output,
      encoding: "utf8",
    });
    if (r.status) throw Error(r.stderr);
    output = r.stdout;
  }
  if (process.argv.includes("--check")) {
    if ((await readFile(new URL(path, root), "utf8")) !== output)
      throw Error(`Stale contract: ${path}`);
  } else await writeFile(new URL(path, root), output);
  console.log(
    `${process.argv.includes("--check") ? "Checked" : "Generated"} ${path}`,
  );
}
