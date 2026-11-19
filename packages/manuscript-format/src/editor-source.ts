import { fromMarkdown } from "mdast-util-from-markdown";
import {
  readSourceDocument,
  planSourceIdentities,
  sourceMeaning,
} from "./source";
import { decodeString } from "micromark-util-decode-string";
import type {
  AuthoredSourceBinding,
  ManuscriptState,
} from "@scenesparrow/contracts";

export type RawChange = { from: number; to: number; insert: string };
const invalid = (): never => {
  throw Error("SOURCE_RANGE_INVALID");
};
export function scalarBoundary(text: string, at: number) {
  return (
    Number.isSafeInteger(at) &&
    at >= 0 &&
    at <= text.length &&
    !(
      at > 0 &&
      at < text.length &&
      /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[at]!)
    )
  );
}
/** CM Text is only a normalized view. Every boundary retains its raw coordinate. */
export function rawEditorMap(raw: string) {
  let text = "";
  const offsets: number[] = [raw.startsWith("\uFEFF") ? 1 : 0];
  for (let at = offsets[0]!; at < raw.length;) {
    const unit = raw[at]!;
    if (unit === "\r") {
      at += raw[at + 1] === "\n" ? 2 : 1;
      text += "\n";
    } else {
      text += unit;
      at++;
    }
    offsets.push(at);
  }
  return {
    text,
    rawAt(at: number) {
      if (!scalarBoundary(text, at)) invalid();
      return offsets[at] ?? invalid();
    },
    editorAt(at: number) {
      if (!scalarBoundary(raw, at)) invalid();
      let low = 0,
        high = offsets.length - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1,
          current = offsets[middle]!;
        if (current === at) return middle;
        if (current < at) low = middle + 1;
        else high = middle - 1;
      }
      return invalid();
    },
  };
}
export function patchEditorSource(raw: string, changes: readonly RawChange[]) {
  const map = rawEditorMap(raw);
  const patches = changes.map(({ from, to, insert }) => {
    if (
      to < from ||
      !scalarBoundary(insert, insert.length) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        insert,
      )
    )
      invalid();
    const start = map.rawAt(from),
      end = map.rawAt(to);
    const lineStart = Math.max(
      raw.lastIndexOf("\n", start - 1),
      raw.lastIndexOf("\r", start - 1),
    );
    const nearby =
      /\r\n|\r|\n/.exec(raw.slice(lineStart + 1))?.[0] ??
      /\r\n|\r|\n/.exec(raw)?.[0] ??
      "\n";
    return {
      from: start,
      to: end,
      insert: insert.replace(/\r\n?|\n/g, nearby),
    };
  });
  let end = -1;
  for (const patch of patches) {
    if (patch.from < end) invalid();
    end = patch.to;
  }
  let next = raw;
  for (const patch of [...patches].reverse())
    next = next.slice(0, patch.from) + patch.insert + next.slice(patch.to);
  return { raw: next, patches };
}
/** Only parser-shaped metadata additions may cross a held ACK. Other changes recover explicitly. */
export function sourceAcknowledgmentInsertions(sent: string, accepted: string) {
  const original = readSourceDocument(sent),
    acknowledged = readSourceDocument(accepted);
  if (original.blocks.length !== acknowledged.blocks.length)
    throw Error("SOURCE_ACK_AMBIGUOUS");
  const assignments: { address: string; id: string }[] = [];
  for (let index = 0; index < acknowledged.blocks.length; index++) {
    const before = original.blocks[index]!,
      after = acknowledged.blocks[index]!;
    if (before.kind !== after.kind) throw Error("SOURCE_ACK_AMBIGUOUS");
    if (before.id === after.id) continue;
    if (before.id || !after.id) throw Error("SOURCE_ACK_AMBIGUOUS");
    assignments.push({ address: before.address, id: after.id });
  }
  const planned = planSourceIdentities(original, assignments);
  if (planned.document.source !== accepted) throw Error("SOURCE_ACK_AMBIGUOUS");
  return planned.insertions.map((insertion) => ({ ...insertion }));
}
export function rebaseSourceAcknowledgment(
  sent: string,
  accepted: string,
  pending: readonly (readonly RawChange[])[],
  current: string,
) {
  const insertions = sourceAcknowledgmentInsertions(sent, accepted);
  let expected = sent;
  for (const batch of pending) {
    let end = -1;
    const owners = insertions.length ? readSourceDocument(expected).blocks : [];
    for (const patch of batch) {
      if (
        insertions.length &&
        !owners.some(
          (leaf) => patch.from >= leaf.startUtf16 && patch.to <= leaf.endUtf16,
        )
      )
        throw Error("SOURCE_ACK_AMBIGUOUS");
      if (
        patch.from < end ||
        patch.to < patch.from ||
        !scalarBoundary(expected, patch.from) ||
        !scalarBoundary(expected, patch.to)
      )
        invalid();
      end = patch.to;
    }
    for (const patch of [...batch].reverse())
      expected =
        expected.slice(0, patch.from) + patch.insert + expected.slice(patch.to);
  }
  if (expected !== current) throw Error("SOURCE_ACK_AMBIGUOUS");
  for (const batch of pending)
    for (const insertion of insertions) {
      let shift = 0;
      for (const patch of batch) {
        if (patch.from < insertion.at && patch.to > insertion.at)
          throw Error("SOURCE_ACK_AMBIGUOUS");
        if (
          patch.to < insertion.at ||
          (patch.to === insertion.at &&
            (patch.from < patch.to || insertion.assoc > 0))
        )
          shift += patch.insert.length - (patch.to - patch.from);
      }
      insertion.at += shift;
    }
  const pieces: string[] = [];
  let cursor = 0;
  let previous = -1;
  for (const insertion of insertions.sort((a, b) => a.at - b.at)) {
    if (insertion.at < cursor || insertion.at === previous)
      throw Error("SOURCE_ACK_AMBIGUOUS");
    pieces.push(current.slice(cursor, insertion.at), insertion.text);
    cursor = insertion.at;
    previous = insertion.at;
  }
  pieces.push(current.slice(cursor));
  const result = pieces.join("");
  if (insertions.length) {
    // Native IDs belong to the submitted leaves. A split, inserted heading or
    // deleted leaf can change ownership even when offset mapping is unambiguous.
    // Keep both versions for explicit recovery rather than bind an ID by position.
    try {
      const before = readSourceDocument(sent).blocks;
      const local = readSourceDocument(current).blocks;
      const rebased = readSourceDocument(result).blocks;
      const canonical = readSourceDocument(accepted).blocks;
      if (
        before.length !== local.length ||
        local.length !== rebased.length ||
        local.some(
          (block, index) =>
            block.kind !== before[index]!.kind ||
            block.kind !== rebased[index]!.kind ||
            rebased[index]!.id !== canonical[index]!.id ||
            (block.id !== undefined && block.id !== rebased[index]!.id),
        ) ||
        JSON.stringify(sourceMeaning(current)) !==
          JSON.stringify(sourceMeaning(result))
      )
        throw Error("SOURCE_ACK_AMBIGUOUS");
    } catch {
      throw Error("SOURCE_ACK_AMBIGUOUS");
    }
  }
  return result;
}

export type SourceSelection = {
  blockId: string;
  text: string;
  start: number;
  end: number;
  quote: string;
  wholeBlock: boolean;
};
type Ast = {
  type: string;
  value?: string;
  children?: Ast[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
/** CommonMark inline-code text, derived once from the exact parser token. */
export function codeSpanContent(literal: string, from = 0) {
  const delimiter = /^`+/.exec(literal)?.[0] ?? invalid();
  if (!literal.endsWith(delimiter) || literal.length < delimiter.length * 2)
    invalid();
  const chunks = [
    ...literal
      .slice(delimiter.length, -delimiter.length)
      .matchAll(/\r\n|\r|\n|[^]/gu),
  ].map((match) => ({
    from: from + delimiter.length + match.index!,
    raw: match[0],
    value: /^[\r\n]/.test(match[0]) ? " " : match[0],
  }));
  if (
    chunks[0]?.value === " " &&
    chunks.at(-1)?.value === " " &&
    chunks.some((c) => c.value !== " ")
  ) {
    chunks.shift();
    chunks.pop();
  }
  return {
    delimiter,
    chunks,
    text: chunks.map((chunk) => chunk.value).join(""),
  };
}
/** Token-owned raw/decoded boundaries. Never locate a block by searching its text. */
export function sourceSelectionMap(
  raw: string,
  bindings: readonly AuthoredSourceBinding[],
  state: ManuscriptState,
) {
  const ast = fromMarkdown(raw) as Ast;
  const byteOffsets = new Map<number, number>([[0, 0]]);
  let bytes = 0,
    units = 0;
  for (const scalar of raw) {
    bytes += new TextEncoder().encode(scalar).length;
    units += scalar.length;
    byteOffsets.set(bytes, units);
  }
  return bindings.map((binding) => {
    const start = byteOffsets.get(binding.startUtf8),
      end = byteOffsets.get(binding.endUtf8);
    if (start === undefined || end === undefined) invalid();
    const block = state.blocks.find((b) => b.id === binding.id);
    let node = ast;
    for (const part of binding.address.split("/").filter(Boolean)) {
      if (!/^\d+$/.test(part) || !node.children?.[Number(part)])
        return { binding, start, end, block, map: null };
      node = node.children[Number(part)]!;
    }
    let text = "";
    const map = new Map<number, number>();
    let supported = binding.semanticEditable && !!block;
    const emit = (value: string, from: number, to: number) => {
      map.set(from, text.length);
      text += value;
      map.set(to, text.length);
    };
    const walk = (token: Ast): void => {
      const tokenFrom = token.position?.start.offset,
        tokenTo = token.position?.end.offset;
      const from =
          tokenFrom === undefined
            ? undefined
            : tokenFrom + (raw.startsWith("\uFEFF") ? 1 : 0),
        to =
          tokenTo === undefined
            ? undefined
            : tokenTo + (raw.startsWith("\uFEFF") ? 1 : 0);
      if (from === undefined || to === undefined) {
        supported = false;
        return;
      }
      if (token.children) {
        map.set(from, text.length);
        for (const child of token.children) walk(child);
        map.set(to, text.length);
        return;
      }
      const literal = raw.slice(from, to);
      if (token.type === "text") {
        let at = from;
        for (const match of literal.matchAll(
          /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);|\r\n|\r|[^]/gu,
        )) {
          const encoded = match[0],
            decoded = decodeString(encoded).replace(/\r\n?/g, "\n");
          if (decoded === encoded && encoded.length > 1) {
            let cursor = at;
            for (const scalar of encoded) {
              emit(scalar, cursor, cursor + scalar.length);
              cursor += scalar.length;
            }
          } else {
            if (encoded.startsWith("\\")) map.set(at + 1, text.length);
            emit(decoded, at, at + encoded.length);
          }
          at += encoded.length;
        }
      } else if (token.type === "inlineCode") {
        const code = codeSpanContent(literal, from);
        map.set(from, text.length);
        for (const chunk of code.chunks)
          emit(chunk.value, chunk.from, chunk.from + chunk.raw.length);
        map.set(to, text.length);
      } else if (token.type === "break") emit("\n", from, to);
      else if (
        token.type === "html" &&
        /^<!-- scenesparrow:(?:block|empty)=/.test(literal)
      )
        return;
      else supported = false;
    };
    walk(node);
    if (text !== block?.runs.map((r) => r.text).join("")) supported = false;
    return { binding, start, end, block, map: supported ? map : null };
  });
}
export function captureSourceSelection(
  raw: string,
  bindings: readonly AuthoredSourceBinding[],
  state: ManuscriptState,
  from: number,
  to: number,
  wholeBlock = false,
  wholeDocument = false,
): SourceSelection[] {
  const positions = sourceSelectionMap(raw, bindings, state);
  const selected = positions.filter(
    (p) =>
      wholeDocument ||
      (wholeBlock
        ? from >= p.start! && from <= p.end!
        : from < p.end! && to > p.start!),
  );
  if (
    !selected.length ||
    selected.length > 100 ||
    (!wholeBlock && !wholeDocument && from === to)
  )
    throw Error("SOURCE_SELECTION_UNSUPPORTED");
  return selected.map((p) => {
    if (!p.map || !p.block) throw Error("SOURCE_SELECTION_UNSUPPORTED");
    const text = p.block.runs.map((r) => r.text).join("");
    const start =
      wholeBlock || wholeDocument ? 0 : p.map.get(Math.max(from, p.start!));
    const end =
      wholeBlock || wholeDocument
        ? text.length
        : p.map.get(Math.min(to, p.end!));
    const boundaries = new Set([
      0,
      text.length,
      ...[
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
      ].map((s) => s.index),
    ]);
    if (
      start === undefined ||
      end === undefined ||
      !boundaries.has(start) ||
      !boundaries.has(end)
    )
      throw Error("SOURCE_SELECTION_UNSUPPORTED");
    return {
      blockId: p.block.id,
      text,
      start,
      end,
      quote: text.slice(start, end),
      wholeBlock: wholeBlock || wholeDocument,
    };
  });
}

/** Only actual HTML metadata nodes, excluding code literals and authored lookalikes. */
export function sourceMetadataRanges(source: string) {
  const ranges: { from: number; to: number }[] = [];
  const walk = (node: Ast) => {
    if (
      node.type === "html" &&
      /^<!-- scenesparrow:(?:block|empty)=[0-9a-f-]{36} -->$/.test(
        node.value ?? "",
      )
    ) {
      const from = node.position?.start.offset,
        to = node.position?.end.offset;
      if (from !== undefined && to !== undefined)
        ranges.push({
          from: from + (source.startsWith("\uFEFF") ? 1 : 0),
          to: to + (source.startsWith("\uFEFF") ? 1 : 0),
        });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(source) as Ast);
  return ranges;
}

/** Bounded fallback for a checkpoint captured before dispatch. Ambiguous marker
 * crossings still fail rather than replacing newer source. */
export function sourceDifference(before: string, after: string): RawChange[][] {
  if (before === after) return [];
  let from = 0;
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from++;
  while (!scalarBoundary(before, from) || !scalarBoundary(after, from)) from--;
  let to = before.length,
    end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  while (!scalarBoundary(before, to) || !scalarBoundary(after, end)) {
    to++;
    end++;
  }
  return [[{ from, to, insert: after.slice(from, end) }]];
}

export type SourcePresentation = {
  hidden: { from: number; to: number; block: boolean; empty?: boolean }[];
  replacements: {
    from: number;
    to: number;
    text: string;
    className?: string;
  }[];
  marks: { from: number; to: number; className: string }[];
};
/** Presentation comes from CommonMark tokens; unknown syntax is never rendered. */
export function sourcePresentation(source: string): SourcePresentation {
  const result: SourcePresentation = {
    hidden: [],
    replacements: [],
    marks: [],
  };
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const offset = (node: Ast, edge: "start" | "end") =>
    (node.position?.[edge].offset ?? 0) + bom;
  let metadataAllowed = true;
  try {
    readSourceDocument(source);
  } catch {
    metadataAllowed = false;
  }
  const metadata = (node: Ast) =>
    metadataAllowed &&
    node.type === "html" &&
    /^<!-- scenesparrow:(?:block|empty)=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} -->$/.test(
      node.value ?? "",
    );
  const hide = (from: number, to: number, block = false) => {
    if (to > from) result.hidden.push({ from, to, block });
  };
  const mark = (from: number, to: number, className: string) => {
    if (to > from) result.marks.push({ from, to, className });
  };
  const walk = (node: Ast) => {
    const from = offset(node, "start"),
      to = offset(node, "end");
    if (metadata(node)) {
      let end = to;
      const lineStart = source.lastIndexOf("\n", from - 1) + 1;
      const standalone =
        source.slice(lineStart, from).trim() === "" &&
        /^\r?\n/.test(source.slice(to));
      if (standalone && !node.value!.startsWith("<!-- scenesparrow:empty=")) {
        end += /^\r?\n(?:[ \t]*\r?\n)?/.exec(source.slice(to))![0].length;
        hide(lineStart, end, true);
      } else {
        hide(from, to);
        if (node.value!.startsWith("<!-- scenesparrow:empty="))
          result.hidden.at(-1)!.empty = true;
      }
      return;
    }
    const children = node.children;
    if (
      ["heading", "strong", "emphasis", "link", "linkReference"].includes(
        node.type,
      ) &&
      children?.length
    ) {
      hide(from, offset(children[0]!, "start"));
      hide(offset(children.at(-1)!, "end"), to);
      mark(
        offset(children[0]!, "start"),
        offset(children.at(-1)!, "end"),
        `source-live-${node.type}`,
      );
    }
    if (node.type === "inlineCode") {
      const code = codeSpanContent(source.slice(from, to), from);
      result.replacements.push({
        from,
        to,
        text: code.text,
        className: "source-live-code",
      });
      return;
    }
    if (node.type === "text") {
      const literal = source.slice(from, to);
      for (const match of literal.matchAll(
        /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g,
      )) {
        const decoded = decodeString(match[0]);
        if (decoded !== match[0])
          result.replacements.push({
            from: from + match.index!,
            to: from + match.index! + match[0].length,
            text: decoded,
          });
      }
    }
    if (node.type === "code") {
      mark(from, to, "source-live-code-block");
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(source) as Ast);
  return result;
}

export type SourceDiffLine = {
  kind: "equal" | "added" | "removed";
  text: string;
  before: number | null;
  after: number | null;
};
/** Unique-line anchors bound comparison to linear work and a small visible budget. */
export function sourceDiff(before: string, after: string, limit = 120) {
  const allBefore = before.split(/\r\n?|\n/),
    allAfter = after.split(/\r\n?|\n/);
  const a = allBefore.slice(0, 20_000),
    b = allAfter.slice(0, 20_000);
  const count = (lines: string[]) => {
    const counts = new Map<string, { count: number; at: number }>();
    lines.forEach((text, at) => {
      const prior = counts.get(text);
      counts.set(text, { count: (prior?.count ?? 0) + 1, at });
    });
    return counts;
  };
  const ac = count(a),
    bc = count(b),
    anchors: { a: number; b: number }[] = [];
  let last = -1;
  for (let index = 0; index < a.length; index++) {
    const text = a[index]!,
      target = bc.get(text);
    if (
      text &&
      ac.get(text)!.count === 1 &&
      target?.count === 1 &&
      target.at > last
    ) {
      anchors.push({ a: index, b: target.at });
      last = target.at;
    }
  }
  anchors.push({ a: a.length, b: b.length });
  const operations: SourceDiffLine[] = [];
  let ai = 0,
    bi = 0;
  const emit = (
    kind: SourceDiffLine["kind"],
    text: string,
    before: number | null,
    after: number | null,
  ) => operations.push({ kind, text, before, after });
  for (const anchor of anchors) {
    while (ai < anchor.a && bi < anchor.b && a[ai] === b[bi]) {
      emit("equal", a[ai]!, ai + 1, bi + 1);
      ai++;
      bi++;
    }
    while (ai < anchor.a) {
      emit("removed", a[ai]!, ++ai, null);
    }
    while (bi < anchor.b) {
      emit("added", b[bi]!, null, ++bi);
    }
    if (ai < a.length && bi < b.length) {
      emit("equal", a[ai]!, ai + 1, bi + 1);
      ai++;
      bi++;
    }
  }
  const windows: { from: number; to: number }[] = [];
  for (let index = 0; index < operations.length; index++)
    if (operations[index]!.kind !== "equal") {
      const from = Math.max(0, index - 3),
        to = Math.min(operations.length, index + 4),
        last = windows.at(-1);
      if (last && from <= last.to) last.to = to;
      else windows.push({ from, to });
    }
  let remaining = limit;
  const hunks = windows.flatMap((window) => {
    if (!remaining) return [];
    const lines = operations.slice(
      window.from,
      Math.min(window.to, window.from + remaining),
    );
    remaining -= lines.length;
    return [lines];
  });
  const total = windows.reduce(
    (sum, window) => sum + window.to - window.from,
    0,
  );
  return {
    hunks,
    truncated:
      total > limit ||
      allBefore.length > a.length ||
      allAfter.length > b.length,
    identityOnly: before !== after && a.join("\n") === b.join("\n"),
    changed: before !== after,
  };
}

/** Textarea edits use the same exact raw participant as CodeMirror. */
export function patchNormalizedSourceInput(raw: string, normalized: string) {
  return patchEditorSource(
    raw,
    sourceDifference(rawEditorMap(raw).text, normalized).flat(),
  ).raw;
}

/** Maintain a proved existing root leaf when live input empties or retypes it.
 * All authored bytes outside that owned span retain their original coordinates. */
export function repairLiveSourceInput(
  raw: string,
  changes: readonly RawChange[],
) {
  const proposed = patchEditorSource(raw, changes);
  let source = proposed.raw;
  let before: ReturnType<typeof readSourceDocument>;
  try {
    before = readSourceDocument(raw);
  } catch {
    return { raw: source, cursorRaw: null };
  }
  const ranges = sourceMetadataRanges(raw),
    eol = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
  for (let index = 0; index < before.blocks.length; index++) {
    const block = before.blocks[index]!;
    if (
      !block.id ||
      block.address.split("/").length !== 2 ||
      !["paragraph", "empty"].includes(block.kind)
    )
      continue;
    const metadata = ranges.find((range) =>
      raw.slice(range.from, range.to).includes(`=${block.id} -->`),
    );
    if (!metadata) continue;
    const marker = raw.slice(metadata.from, metadata.to);
    if (block.kind === "paragraph") {
      const owned = raw.slice(metadata.from, block.endUtf16);
      let fragment = owned;
      const related = proposed.patches.filter(
        (patch) => patch.from >= metadata.from && patch.to <= block.endUtf16,
      );
      for (const patch of [...related].reverse())
        fragment =
          fragment.slice(0, patch.from - metadata.from) +
          patch.insert +
          fragment.slice(patch.to - metadata.from);
      const onlyLeaf =
        before.blocks.length === 1 &&
        source.replace(/^\uFEFF/, "").trim() === "";
      const empty =
        fragment.replace(marker, "").trim() === "" && related.length > 0;
      if (!onlyLeaf && !empty) continue;
      if (
        !onlyLeaf &&
        proposed.patches.some(
          (patch) =>
            (patch.from < metadata.from && patch.to > metadata.from) ||
            (patch.from < block.endUtf16 && patch.to > block.endUtf16),
        )
      )
        continue;
      const replacement = marker.replace(
        "scenesparrow:block=",
        "scenesparrow:empty=",
      );
      if (onlyLeaf)
        source =
          raw.slice(0, metadata.from) + replacement + raw.slice(block.endUtf16);
      else {
        const shift = proposed.patches
          .filter((p) => p.to <= metadata.from)
          .reduce((n, p) => n + p.insert.length - (p.to - p.from), 0);
        const from = metadata.from + shift;
        source =
          source.slice(0, from) +
          replacement +
          source.slice(from + fragment.length);
      }
      return { raw: source, cursorRaw: metadata.from + replacement.length };
    }
    const removal = proposed.patches.find(
      (patch) =>
        patch.from >= metadata.from &&
        patch.to <= metadata.to &&
        patch.to > patch.from &&
        patch.insert === "",
    );
    if (removal) {
      source = raw.slice(0, metadata.from) + raw.slice(metadata.to);
      return { raw: source, cursorRaw: Math.min(metadata.from, source.length) };
    }
    const next = before.blocks[index + 1];
    const insertion = proposed.patches.find(
      (patch) =>
        patch.from === patch.to &&
        patch.from >= metadata.from &&
        patch.from <= (next?.startUtf16 ?? raw.length) &&
        patch.insert.trim() &&
        (patch.from === metadata.from ||
          patch.from === metadata.to ||
          (patch.from >= metadata.to &&
            raw.slice(metadata.to, patch.from).trim() === "")),
    );
    if (!insertion) continue;
    const bound = marker.replace("scenesparrow:empty=", "scenesparrow:block=");
    if (
      insertion.from >= metadata.to &&
      /(?:\r\n|\r|\n){2}/.test(raw.slice(metadata.to, insertion.from))
    ) {
      const shift = proposed.patches
          .filter((p) => p.to <= metadata.from)
          .reduce((n, p) => n + p.insert.length - (p.to - p.from), 0),
        from = metadata.from + shift;
      source =
        source.slice(0, from) + bound + source.slice(from + marker.length);
      return { raw: source, cursorRaw: null };
    }
    // The zero-width empty leaf has one visual caret position. Place input after
    // its new metadata prefix inside the same authoring transaction.
    const end = Math.max(metadata.to, insertion.to),
      body = bound + eol + eol + insertion.insert;
    source = raw.slice(0, metadata.from) + body + raw.slice(end);
    return { raw: source, cursorRaw: metadata.from + body.length };
  }
  return { raw: source, cursorRaw: null };
}
export function sourceClipboardText(raw: string, from = 0, to = raw.length) {
  let text = "",
    cursor = from;
  for (const range of sourcePresentation(raw).hidden.filter(
    (range) =>
      range.block ||
      raw.slice(range.from, range.to).startsWith("<!-- scenesparrow:"),
  )) {
    if (range.to <= from || range.from >= to) continue;
    text += raw.slice(cursor, Math.max(cursor, range.from));
    cursor = Math.min(to, Math.max(cursor, range.to));
  }
  return text + raw.slice(cursor, to);
}
