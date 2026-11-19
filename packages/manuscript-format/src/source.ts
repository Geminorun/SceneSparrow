import { fromMarkdown } from "mdast-util-from-markdown";
import { stableId } from "@scenesparrow/contracts/open-project";

type Ast = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Ast[];
  [key: string]: unknown;
};
export type SourceCode =
  | "SOURCE_UTF8_INVALID"
  | "SOURCE_BASE_MISMATCH"
  | "SOURCE_RANGE_INVALID"
  | "SOURCE_PATCH_OVERLAP"
  | "IDENTITY_INVALID"
  | "IDENTITY_DUPLICATE"
  | "IDENTITY_MISSING"
  | "IDENTITY_AMBIGUOUS"
  | "IDENTITY_PLACEMENT_UNSUPPORTED";
export class SourceFormatError extends Error {
  readonly code: SourceCode;
  readonly detail: string;
  constructor(code: SourceCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}
function fail(code: SourceCode, detail: string): never {
  throw new SourceFormatError(code, detail);
}
const encoder = new TextEncoder();
const markerPrefix = "<!-- scenesparrow:block=";
const emptyPrefix = "<!-- scenesparrow:empty=";
const marker = (id: string) => `${markerPrefix}${id} -->`;
export type SourceBlock = {
  readonly address: string;
  readonly kind: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly startUtf8: number;
  readonly endUtf8: number;
  /** Nearest list item, if any. Nested children have their own paragraph identity. */
  readonly listItemAddress?: string;
  readonly id?: string;
};
export type SourceDocument = {
  readonly source: string;
  readonly blocks: readonly SourceBlock[];
};
function text(input: string | Uint8Array): string {
  let value: string;
  try {
    value =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            input,
          );
  } catch {
    return fail("SOURCE_UTF8_INVALID", "invalid UTF-8");
  }
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail("SOURCE_UTF8_INVALID", "unpaired surrogate");
  return value;
}
function commentValue(node: Ast): string {
  return node.value?.replace(/^[ \t]+|[ \t]+$/g, "") ?? "";
}
function markerId(node: Ast): string | undefined {
  if (
    node.type !== "html" ||
    !(
      commentValue(node).startsWith(markerPrefix) ||
      commentValue(node).startsWith(emptyPrefix)
    )
  )
    return;
  const match = /^<!-- scenesparrow:(?:block|empty)=([^\s]+) -->$/.exec(
    commentValue(node),
  );
  if (!match)
    fail("IDENTITY_AMBIGUOUS", "reserved comment is not one isolated marker");
  const id = match[1]!;
  if (!stableId(id)) fail("IDENTITY_INVALID", id);
  return id;
}
const containers = new Set(["root", "list", "listItem", "blockquote"]);
function parse(source: string): Ast {
  const root = fromMarkdown(source) as unknown as Ast;
  // micromark consumes a leading UTF-8 BOM before reporting source offsets.
  if (source.startsWith("\ufeff")) {
    const shift = (node: Ast): void => {
      if (node.position) {
        node.position.start.offset!++;
        node.position.end.offset!++;
      }
      node.children?.forEach(shift);
    };
    shift(root);
  }
  return root;
}
const start = (node: Ast) => node.position!.start.offset!;
const end = (node: Ast) => node.position!.end.offset!;

const capturedTrees = new WeakMap<SourceDocument, Ast>();
/** CommonMark nodes decide comment context. Code, escapes and text never bind IDs. */
export function readSourceDocument(
  input: string | Uint8Array,
  requiredIds: readonly string[] = [],
): SourceDocument {
  const source = text(input);
  return readParsedSource(source, parse(source), requiredIds);
}
function readParsedSource(
  source: string,
  ast: Ast,
  requiredIds: readonly string[],
): SourceDocument {
  const offsets = scalarOffsets(source);
  const blocks: SourceBlock[] = [];
  const ids = new Set<string>();
  const visit = (parent: Ast, path: string, listItem?: string): void => {
    const children = parent.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!;
      const address = `${path}/${i}`;
      const standalone = markerId(node);
      if (standalone && commentValue(node).startsWith(emptyPrefix)) {
        if (
          parent.type !== "root" &&
          (children.some(
            (sibling) => sibling !== node && !containers.has(sibling.type),
          ) ||
            !["listItem", "blockquote"].includes(parent.type))
        )
          fail("IDENTITY_AMBIGUOUS", address);
        if (ids.has(standalone)) fail("IDENTITY_DUPLICATE", standalone);
        ids.add(standalone);
        blocks.push(
          Object.freeze({
            address,
            kind: "empty",
            startUtf16: start(node),
            endUtf16: end(node),
            startUtf8: offsets.byteAt(start(node)),
            endUtf8: offsets.byteAt(end(node)),
            ...(listItem ? { listItemAddress: listItem } : {}),
            id: standalone,
          }),
        );
        continue;
      }
      if (standalone) {
        const target = children[i + 1];
        if (!target || containers.has(target.type) || markerId(target))
          fail("IDENTITY_AMBIGUOUS", address);
        continue;
      }
      if (containers.has(node.type)) {
        if (
          (node.type === "listItem" ||
            (node.type === "blockquote" && !node.children?.length)) &&
          (node.children ?? []).every((child) => containers.has(child.type))
        ) {
          blocks.push(
            Object.freeze({
              address: `${address}/empty`,
              kind: "empty",
              startUtf16: start(node),
              endUtf16: start(node),
              startUtf8: offsets.byteAt(start(node)),
              endUtf8: offsets.byteAt(start(node)),
              ...(node.type === "listItem"
                ? { listItemAddress: address }
                : listItem
                  ? { listItemAddress: listItem }
                  : {}),
            }),
          );
        }
        visit(node, address, node.type === "listItem" ? address : listItem);
        continue;
      }
      let id =
        i > 0 && !commentValue(children[i - 1]!).startsWith(emptyPrefix)
          ? markerId(children[i - 1]!)
          : undefined;
      const inline = (node.children ?? []).flatMap((child, index) => {
        const found = markerId(child);
        if (found && commentValue(child).startsWith(emptyPrefix))
          fail("IDENTITY_AMBIGUOUS", address);
        if (
          found &&
          !(
            (node.type === "heading" &&
              (index === 0 || index === node.children!.length - 1)) ||
            (node.type === "paragraph" && index === node.children!.length - 1)
          )
        )
          fail("IDENTITY_AMBIGUOUS", address);
        return found ? [found] : [];
      });
      if (inline.length > 1 || (id && inline.length))
        fail("IDENTITY_AMBIGUOUS", address);
      id ??= inline[0];
      // Metadata under emphasis/link wrappers is not an owned block prefix.
      const inspectNested = (child: Ast): void => {
        for (const nested of child.children ?? []) {
          if (markerId(nested)) fail("IDENTITY_AMBIGUOUS", address);
          inspectNested(nested);
        }
      };
      for (const child of node.children ?? []) inspectNested(child);
      if (id && ids.has(id)) fail("IDENTITY_DUPLICATE", id);
      if (id) ids.add(id);
      blocks.push(
        Object.freeze({
          address,
          kind: node.type,
          startUtf16: start(node),
          endUtf16: end(node),
          startUtf8: offsets.byteAt(start(node)),
          endUtf8: offsets.byteAt(end(node)),
          ...(listItem ? { listItemAddress: listItem } : {}),
          ...(id ? { id } : {}),
        }),
      );
    }
  };
  visit(ast, "");
  if (!(ast.children ?? []).length)
    blocks.push(
      Object.freeze({
        address: "/empty",
        kind: "empty",
        startUtf16: source.length,
        endUtf16: source.length,
        startUtf8: offsets.byteAt(source.length),
        endUtf8: offsets.byteAt(source.length),
      }),
    );
  for (const id of requiredIds) {
    if (!stableId(id)) fail("IDENTITY_INVALID", id);
    if (!ids.has(id)) fail("IDENTITY_MISSING", id);
  }
  const document = Object.freeze({ source, blocks: Object.freeze(blocks) });
  capturedTrees.set(document, ast);
  return document;
}
export function sourceBytes(document: SourceDocument): Uint8Array {
  return encoder.encode(document.source);
}
export type SourcePatch = { start: number; end: number; replacement: string };
export type SourceOffsetUnit = "utf16" | "utf8";
// One scalar pass per document/batch; binary lookups avoid re-encoding every
// block prefix or scanning the entire source separately for every patch.
function scalarOffsets(source: string) {
  const units = new Uint32Array(source.length + 1);
  const bytes = new Uint32Array(source.length + 1);
  let count = 1;
  let unit = 0;
  let byte = 0;
  for (const scalar of source) {
    const point = scalar.codePointAt(0)!;
    unit += scalar.length;
    byte += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    units[count] = unit;
    bytes[count++] = byte;
  }
  const lookup = (offset: number, values: Uint32Array): number => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      fail("SOURCE_RANGE_INVALID", String(offset));
    let low = 0,
      high = count - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const current = values[mid]!;
      if (current === offset) return mid;
      if (current < offset) low = mid + 1;
      else high = mid - 1;
    }
    return fail("SOURCE_RANGE_INVALID", String(offset));
  };
  return {
    byteAt: (offset: number) => bytes[lookup(offset, units)]!,
    unitAt: (offset: number, coordinate: SourceOffsetUnit) =>
      units[lookup(offset, coordinate === "utf8" ? bytes : units)]!,
  };
}
/** Ranges are against the captured base, half-open, in an explicitly named unit. */
export function applySourcePatches(
  document: SourceDocument,
  expectedBase: Uint8Array,
  patches: readonly SourcePatch[],
  unit: SourceOffsetUnit,
): Uint8Array {
  if (unit !== "utf16" && unit !== "utf8")
    fail("SOURCE_RANGE_INVALID", "unknown coordinate unit");
  if (text(expectedBase) !== document.source)
    fail("SOURCE_BASE_MISMATCH", "source changed");
  const offsets = scalarOffsets(document.source);
  const sorted = patches
    .map((patch) => ({
      start: offsets.unitAt(patch.start, unit),
      end: offsets.unitAt(patch.end, unit),
      replacement: text(patch.replacement),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  let previous: { start: number; end: number } | undefined;
  let output = "";
  for (const patch of sorted) {
    if (patch.end < patch.start) fail("SOURCE_RANGE_INVALID", "reversed range");
    if (
      previous &&
      (patch.start < previous.end || patch.start === previous.start)
    )
      fail("SOURCE_PATCH_OVERLAP", "overlapping ranges");
    output += document.source.slice(cursor, patch.start) + patch.replacement;
    cursor = patch.end;
    previous = patch;
  }
  return encoder.encode(output + document.source.slice(cursor));
}

/** Semantic proof value, retaining list tightness, code payloads and raw HTML. */
export function sourceMeaning(input: string | Uint8Array): unknown {
  return meaningAst(parse(text(input)));
}
function meaningAst(ast: Ast): unknown {
  const clean = (node: Ast): unknown => {
    if (markerId(node)) return undefined;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "position")
        .map(([key, value]) => [
          key,
          key === "children"
            ? (value as Ast[]).map(clean).filter((child) => child !== undefined)
            : value,
        ]),
    );
  };
  return clean(ast);
}
export type SourceIdentityAssignment = { address: string; id: string };
export type SourceIdentityInsertion = {
  at: number;
  text: string;
  assoc: number;
};
/** Plan all insertions against one captured AST, then prove bindings/meaning once. */
export function planSourceIdentities(
  document: SourceDocument,
  assignments: readonly SourceIdentityAssignment[],
): {
  document: SourceDocument;
  insertions: readonly SourceIdentityInsertion[];
} {
  if (!assignments.length) return { document, insertions: [] };
  const ast = capturedTrees.get(document) ?? parse(document.source);
  const blocks = new Map(
    document.blocks.map((block) => [block.address, block]),
  );
  const ids = new Set(
    document.blocks.flatMap((block) => (block.id ? [block.id] : [])),
  );
  const assigned = new Map<string, string>();
  const eol = document.source.includes("\r\n") ? "\r\n" : "\n";
  const planned: SourceIdentityInsertion[] = [];
  for (const { address, id } of assignments) {
    if (!stableId(id)) fail("IDENTITY_INVALID", id);
    if (ids.has(id)) fail("IDENTITY_DUPLICATE", id);
    const block = blocks.get(address);
    if (!block || block.id || assigned.has(address))
      fail("IDENTITY_AMBIGUOUS", address);
    ids.add(id);
    assigned.set(address, id);
    planned.push(identityInsertion(document, ast, block, id, eol));
  }
  const insertions: SourceIdentityInsertion[] = [];
  for (const insertion of planned.sort((a, b) => a.at - b.at)) {
    const previous = insertions.at(-1);
    if (previous?.at === insertion.at) {
      if (previous.assoc !== insertion.assoc)
        fail("IDENTITY_PLACEMENT_UNSUPPORTED", "shared offset");
      previous.text += insertion.text;
    } else insertions.push({ ...insertion });
  }
  const candidate = applySourcePatches(
    document,
    sourceBytes(document),
    insertions.map(({ at, text }) => ({
      start: at,
      end: at,
      replacement: text,
    })),
    "utf16",
  );
  let result: SourceDocument;
  try {
    const source = text(candidate);
    const candidateAst = parse(source);
    result = readParsedSource(source, candidateAst, [...ids]);
    if (
      result.blocks.length !== document.blocks.length ||
      result.blocks.some(
        (block, index) =>
          block.kind !== document.blocks[index]!.kind ||
          block.id !==
            (assigned.get(document.blocks[index]!.address) ??
              document.blocks[index]!.id),
      ) ||
      JSON.stringify(meaningAst(ast)) !==
        JSON.stringify(meaningAst(candidateAst))
    )
      fail("IDENTITY_PLACEMENT_UNSUPPORTED", "batch");
  } catch {
    return fail(
      "IDENTITY_PLACEMENT_UNSUPPORTED",
      assignments.map(({ address }) => address).join(","),
    );
  }
  return { document: result, insertions };
}
/** Insert exactly one ID using the frozen batch placement/proof. */
export function insertSourceIdentity(
  document: SourceDocument,
  address: string,
  id: string,
): SourceDocument {
  return planSourceIdentities(document, [{ address, id }]).document;
}
function identityInsertion(
  document: SourceDocument,
  ast: Ast,
  block: SourceBlock,
  id: string,
  eol: string,
): SourceIdentityInsertion {
  const address = block.address;
  const source = document.source;
  let offset = block.startUtf16;
  let insertion: string;
  if (block.kind === "empty") {
    const parentAddress = address === "/empty" ? "" : address.slice(0, -6);
    let parent = ast;
    for (const part of parentAddress.split("/").filter(Boolean))
      parent = parent.children![Number(part)]!;
    if (parent.type === "root") {
      offset = source.length;
      insertion = `${source && !source.endsWith("\n") ? eol : ""}${emptyPrefix}${id} -->${eol}`;
    } else {
      const firstContainer = parent.children?.[0];
      offset = firstContainer ? start(firstContainer) : end(parent);
      if (firstContainer) {
        const prefix = source.slice(
          source.lastIndexOf("\n", offset - 1) + 1,
          offset,
        );
        const continuation = prefix.replace(
          /(?:[-+*]|\d+[.)])([ \t]+)/g,
          (value) => " ".repeat(value.length),
        );
        insertion = `${emptyPrefix}${id} -->${eol}${continuation}`;
      } else insertion = ` ${emptyPrefix}${id} -->`;
    }
  } else if (block.kind === "paragraph" || block.kind === "heading") {
    // Root simple blocks get standalone metadata; container leaves use an inline
    // suffix to retain tight-list semantics and unambiguous child ownership.
    const nested = address.split("/").length > 2;
    if (!nested) insertion = `${marker(id)}${eol}${eol}`;
    else {
      let leading = "",
        trailing = "";
      if (block.kind === "paragraph")
        offset =
          block.endUtf16 -
          (/[ \t]*$/.exec(source.slice(offset, block.endUtf16))?.[0].length ??
            0);
      if (block.kind === "heading") {
        let heading = ast;
        for (const part of address.split("/").filter(Boolean))
          heading = heading.children![Number(part)]!;
        const last = heading.children?.at(-1);
        if (last) offset = end(last);
        else {
          const prefix = /^#{1,6}(?:[ \t]+|$)/.exec(
            source.slice(offset, block.endUtf16),
          );
          if (prefix) {
            offset += prefix[0].length;
            if (!/[ \t]$/.test(prefix[0])) leading = " ";
            if (/^#+[ \t]*$/.test(source.slice(offset, block.endUtf16)))
              trailing = " ";
          }
        }
      }
      insertion = leading + marker(id) + trailing;
    }
  } else {
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    const prefix = source.slice(lineStart, offset);
    const continuation = prefix.replace(/(?:[-+*]|\d+[.)])([ \t]+)/g, (value) =>
      " ".repeat(value.length),
    );
    insertion = `${marker(id)}${eol}${continuation}`;
  }
  return {
    at: offset,
    text: insertion,
    assoc:
      (block.kind === "paragraph" || block.kind === "heading") &&
      address.split("/").length > 2
        ? 1
        : -1,
  };
}
