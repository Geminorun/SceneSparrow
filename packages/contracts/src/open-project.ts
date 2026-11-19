import schema from "../schema/open-project.schema.json";
import type { OpenProjectManifest } from "./generated";

export type ProjectFormatCode =
  | "FORMAT_INVALID"
  | "IDENTITY_INVALID"
  | "PATH_INVALID"
  | "PATH_COLLISION"
  | "EXTENSIONS_INVALID";
export class ProjectFormatError extends Error {
  constructor(
    public readonly code: ProjectFormatCode,
    public readonly field: string,
  ) {
    super(`${code}: ${field}`);
  }
}
function fail(code: ProjectFormatCode, field: string): never {
  throw new ProjectFormatError(code, field);
}
export const stableId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

// Conservative Unicode caseless key, also catching final sigma and ligatures.
const portableKey = (path: string) =>
  path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

/** Logical paths only. OP2 must separately enforce physical links at every I/O. */
export function validatePortablePaths(paths: readonly string[]): void {
  const entries = new Map<string, string>();
  for (const path of paths) {
    if (!path || /[\\\u0000-\u001f\u007f-\u009f<>:"|?*]/u.test(path))
      fail("PATH_INVALID", path);
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/u.test(segment) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/u.test(
          portableKey(segment),
        )
      )
        fail("PATH_INVALID", path);
      // Prefixes participate too: Foo/a and foo/b conflict on portable systems.
      const original = segments.slice(0, i + 1).join("/");
      const key = portableKey(original);
      const previous = entries.get(key);
      if (previous !== undefined && previous !== original)
        fail("PATH_COLLISION", path);
      entries.set(key, original);
    }
  }
  const keys = new Set(paths.map((p) => portableKey(p)));
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++)
      if (keys.has(portableKey(segments.slice(0, i).join("/"))))
        fail("PATH_COLLISION", path);
  }
  if (keys.size !== paths.length) fail("PATH_COLLISION", "paths");
}

type Shape = {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Shape>;
  additionalProperties?: boolean | Shape;
  items?: Shape;
};
const definitions = schema.definitions as Record<string, Shape>;
function validateShape(value: unknown, shape: Shape, field: string): void {
  if (shape.$ref) {
    const name = shape.$ref.split("/").at(-1)!;
    if (name === "FileJsonValue") return;
    if (name === "FileExtensions") {
      validateExtensions(value, field);
      return;
    }
    return validateShape(value, definitions[name]!, field);
  }
  if (shape.enum && !shape.enum.includes(value)) fail("FORMAT_INVALID", field);
  if (shape.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("FORMAT_INVALID", field);
    const object = value as Record<string, unknown>;
    for (const key of shape.required ?? [])
      if (!Object.hasOwn(object, key))
        fail("FORMAT_INVALID", `${field}.${key}`);
    for (const [key, child] of Object.entries(object)) {
      const property = Object.hasOwn(shape.properties ?? {}, key)
        ? shape.properties?.[key]
        : undefined;
      if (!property) fail("FORMAT_INVALID", `${field}.${key}`);
      validateShape(child, property, `${field}.${key}`);
    }
  } else if (shape.type === "array") {
    if (!Array.isArray(value)) fail("FORMAT_INVALID", field);
    (value as unknown[]).forEach((v, i) =>
      validateShape(v, shape.items!, `${field}.${i}`),
    );
  } else if (shape.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      (shape.minimum !== undefined && value < shape.minimum) ||
      (shape.maximum !== undefined && value > shape.maximum)
    )
      fail("FORMAT_INVALID", field);
  } else if (typeof value !== shape.type) fail("FORMAT_INVALID", field);
}
function validateExtensions(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("EXTENSIONS_INVALID", field);
  const keys = Object.keys(value as object);
  if (
    keys.length > 64 ||
    keys.some((k) => !/^[a-z][a-z0-9.-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(k))
  )
    fail("EXTENSIONS_INVALID", field);
  const visit = (v: unknown, depth: number): void => {
    if (depth > 16) fail("EXTENSIONS_INVALID", field);
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v) fail("EXTENSIONS_INVALID", field);
    for (const child of Object.values(v as object)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
    fail("EXTENSIONS_INVALID", field);
}
const protectedPath = (path: string) =>
  path
    .split("/")
    .some((segment) =>
      [".scenesparrow", ".git"].includes(portableKey(segment)),
    );

function validateRolePath(
  path: string,
  role: "manuscript" | "audio" | "video",
): void {
  if (
    protectedPath(path) ||
    !(
      role === "manuscript"
        ? /\.md$/i
        : role === "audio"
          ? /\.json$/i
          : /\.(?:tsx?|jsx?)$/i
    ).test(path)
  )
    fail("PATH_INVALID", role);
}
export type ManifestInspection =
  | { kind: "supported"; manifest: OpenProjectManifest }
  | {
      kind: "future-read-only";
      raw: Record<string, unknown>;
      formatVersion: number;
    };
/** Input is parsed JSON. No file access, initialization, writes or coercion. */
export function inspectProjectManifest(value: unknown): ManifestInspection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("FORMAT_INVALID", "manifest");
  const raw = value as Record<string, unknown>;
  if (
    raw.format !== "scenesparrow" ||
    !Number.isSafeInteger(raw.formatVersion) ||
    (raw.formatVersion as number) < 1
  )
    fail("FORMAT_INVALID", "formatVersion");
  if ((raw.formatVersion as number) > 1)
    return {
      kind: "future-read-only",
      raw,
      formatVersion: raw.formatVersion as number,
    };
  validateShape(value, definitions.OpenProjectManifest!, "manifest");
  const manifest = value as OpenProjectManifest;
  if (!stableId(manifest.projectId)) fail("IDENTITY_INVALID", "projectId");
  if (
    manifest.name !== undefined &&
    (!manifest.name.trim() ||
      [...manifest.name].length > 120 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(manifest.name))
  )
    fail("FORMAT_INVALID", "name");
  if (manifest.video && !manifest.video.compositionId.trim())
    fail("FORMAT_INVALID", "compositionId");
  validateRolePath(manifest.manuscript, "manuscript");
  if (manifest.audio) validateRolePath(manifest.audio.plan, "audio");
  if (manifest.video) validateRolePath(manifest.video.entry, "video");
  validatePortablePaths([
    "project.json",
    manifest.manuscript,
    ...(manifest.audio ? [manifest.audio.plan] : []),
    ...(manifest.video ? [manifest.video.entry] : []),
  ]);
  return { kind: "supported", manifest };
}
/** Versioned declaration validation, without loading media or inventing metadata. */
export function validateMediaDeclaration(
  value: unknown,
  kind: "audio" | "video",
): void {
  validateShape(
    value,
    definitions[
      kind === "audio" ? "AudioPlanDeclaration" : "VideoProjectDeclaration"
    ]!,
    kind,
  );
  if (kind === "video") {
    const video = value as { entry: string; compositionId: string };
    validateRolePath(video.entry, "video");
    validatePortablePaths([video.entry]);
    if (!video.compositionId.trim()) fail("FORMAT_INVALID", "compositionId");
  } else {
    const audio = value as {
      segments: {
        id: string;
        sourceBlockId: string;
        media: string;
        trimStartSample: number;
        trimEndSample: number;
      }[];
    };
    const ids = new Set<string>();
    validatePortablePaths([
      ...new Set(audio.segments.map((segment) => segment.media)),
    ]);
    for (const segment of audio.segments) {
      if (
        !stableId(segment.id) ||
        !stableId(segment.sourceBlockId) ||
        ids.has(segment.id.toLowerCase())
      )
        fail("IDENTITY_INVALID", "segment.id");
      ids.add(segment.id.toLowerCase());
      if (
        protectedPath(segment.media) ||
        !/\.(?:wav|flac)$/i.test(segment.media)
      )
        fail("PATH_INVALID", "media");
      validatePortablePaths([segment.media]);
      if (segment.trimEndSample <= segment.trimStartSample)
        fail("FORMAT_INVALID", "trimEndSample");
    }
  }
}
