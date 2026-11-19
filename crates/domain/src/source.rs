//! Source-preserving CommonMark identity codec. All offsets are UTF-8 bytes.
//! The pinned native micromark implementation owns syntax recognition; marker
//! lookalikes in code, escapes, and raw HTML never become trusted identities.
use crate::open_project::FormatError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, FormatError>;
fn error(code: &'static str, field: impl Into<String>) -> FormatError {
    FormatError {
        code,
        field: field.into(),
    }
}
const BLOCK: &str = "<!-- scenesparrow:block=";
const EMPTY: &str = "<!-- scenesparrow:empty=";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBlock {
    pub address: String,
    pub kind: String,
    pub start_utf8: usize,
    pub end_utf8: usize,
    pub list_item_address: Option<String>,
    pub id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDocument {
    pub source: String,
    pub blocks: Vec<SourceBlock>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePatch {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}
fn kind(node: &Value) -> &str {
    node["type"].as_str().unwrap_or("")
}
fn children(node: &Value) -> &[Value] {
    node["children"].as_array().map_or(&[], Vec::as_slice)
}
fn start(node: &Value) -> usize {
    node["position"]["start"]["offset"]
        .as_u64()
        .expect("native source offset") as usize
}
fn end(node: &Value) -> usize {
    node["position"]["end"]["offset"]
        .as_u64()
        .expect("native source offset") as usize
}
fn comment(node: &Value) -> &str {
    node["value"]
        .as_str()
        .unwrap_or("")
        .trim_matches([' ', '\t'])
}
fn marker(node: &Value) -> Result<Option<&str>> {
    let value = comment(node);
    if kind(node) != "html" || !(value.starts_with(BLOCK) || value.starts_with(EMPTY)) {
        return Ok(None);
    }
    let id = value
        .strip_prefix(BLOCK)
        .or_else(|| value.strip_prefix(EMPTY))
        .and_then(|v| v.strip_suffix(" -->"))
        .filter(|v| !v.chars().any(char::is_whitespace))
        .ok_or_else(|| {
            error(
                "IDENTITY_AMBIGUOUS",
                "reserved comment is not one isolated marker",
            )
        })?;
    if !crate::manuscript::uuid4(id) {
        return Err(error("IDENTITY_INVALID", id));
    }
    Ok(Some(id))
}
fn container(node: &Value) -> bool {
    matches!(kind(node), "root" | "list" | "listItem" | "blockquote")
}
fn parse(source: &str) -> Result<Value> {
    let ast = markdown::to_mdast(source, &markdown::ParseOptions::default())
        .map_err(|_| error("SOURCE_PARSE_FAILED", "CommonMark"))?;
    let mut value = serde_json::to_value(ast).map_err(|_| error("SOURCE_PARSE_FAILED", "AST"))?;
    fn align(node: &mut Value, source: &str) {
        // markdown-rs retains ignored leading indentation on paragraphs;
        // mdast-util-from-markdown reports their first phrasing token instead.
        if kind(node) == "paragraph"
            && let Some(first) = children(node).first()
        {
            let previous = start(node);
            let next = start(first);
            let spaces = source[previous..next]
                .bytes()
                .take_while(|b| b" \t".contains(b))
                .count();
            node["position"]["start"]["offset"] = (previous + spaces).into();
            let column = node["position"]["start"]["column"]
                .as_u64()
                .expect("column");
            node["position"]["start"]["column"] = (column + spaces as u64).into();
        }
        if let Some(children) = node["children"].as_array_mut() {
            children.iter_mut().for_each(|child| align(child, source));
        }
    }
    align(&mut value, source);
    Ok(value)
}
fn nested_markers(node: &Value, address: &str) -> Result<()> {
    for child in children(node) {
        if marker(child)?.is_some() {
            return Err(error("IDENTITY_AMBIGUOUS", address));
        }
        nested_markers(child, address)?;
    }
    Ok(())
}
struct Reader {
    blocks: Vec<SourceBlock>,
    ids: BTreeSet<String>,
}
impl Reader {
    fn push(
        &mut self,
        node: &Value,
        address: String,
        list: Option<&str>,
        id: Option<&str>,
        empty: bool,
    ) -> Result<()> {
        if let Some(id) = id
            && !self.ids.insert(id.into())
        {
            return Err(error("IDENTITY_DUPLICATE", id));
        }
        self.blocks.push(SourceBlock {
            address,
            kind: if empty { "empty" } else { kind(node) }.into(),
            start_utf8: start(node),
            end_utf8: end(node),
            list_item_address: list.map(str::to_owned),
            id: id.map(str::to_owned),
        });
        Ok(())
    }
    fn visit(&mut self, parent: &Value, path: &str, list: Option<&str>) -> Result<()> {
        let siblings = children(parent);
        for (index, node) in siblings.iter().enumerate() {
            let address = format!("{path}/{index}");
            let standalone = marker(node)?;
            if let Some(id) = standalone {
                if comment(node).starts_with(EMPTY) {
                    if kind(parent) != "root"
                        && (!matches!(kind(parent), "listItem" | "blockquote")
                            || siblings
                                .iter()
                                .enumerate()
                                .any(|(i, child)| i != index && !container(child)))
                    {
                        return Err(error("IDENTITY_AMBIGUOUS", address));
                    }
                    self.push(node, address, list, Some(id), true)?;
                } else {
                    let target = siblings
                        .get(index + 1)
                        .ok_or_else(|| error("IDENTITY_AMBIGUOUS", &address))?;
                    if container(target) || marker(target)?.is_some() {
                        return Err(error("IDENTITY_AMBIGUOUS", address));
                    }
                }
                continue;
            }
            if container(node) {
                let list = if kind(node) == "listItem" {
                    Some(address.as_str())
                } else {
                    list
                };
                if (kind(node) == "listItem"
                    || (kind(node) == "blockquote" && children(node).is_empty()))
                    && children(node).iter().all(container)
                {
                    self.push(node, format!("{address}/empty"), list, None, true)?;
                    self.blocks.last_mut().expect("pushed").end_utf8 = start(node);
                }
                self.visit(node, &address, list)?;
                continue;
            }
            let mut id = if index > 0 && !comment(&siblings[index - 1]).starts_with(EMPTY) {
                marker(&siblings[index - 1])?
            } else {
                None
            };
            let mut inline = vec![];
            for (i, child) in children(node).iter().enumerate() {
                if let Some(found) = marker(child)? {
                    if comment(child).starts_with(EMPTY)
                        || !(kind(node) == "heading" && (i == 0 || i == children(node).len() - 1)
                            || kind(node) == "paragraph" && i == children(node).len() - 1)
                    {
                        return Err(error("IDENTITY_AMBIGUOUS", &address));
                    }
                    inline.push(found);
                }
                nested_markers(child, &address)?;
            }
            if inline.len() > 1 || (id.is_some() && !inline.is_empty()) {
                return Err(error("IDENTITY_AMBIGUOUS", address));
            }
            id = id.or_else(|| inline.first().copied());
            self.push(node, address, list, id, false)?;
        }
        Ok(())
    }
}
pub fn read_source(input: &[u8], required: &[&str]) -> Result<SourceDocument> {
    let source = std::str::from_utf8(input).map_err(|_| error("SOURCE_UTF8_INVALID", "source"))?;
    if input.len() > crate::manuscript::MAX_DOCUMENT_BYTES {
        return Err(error("DOCUMENT_TOO_LARGE", "source"));
    }
    let ast = parse(source)?;
    read_parsed(source, &ast, required)
}
fn read_parsed(source: &str, ast: &Value, required: &[&str]) -> Result<SourceDocument> {
    let mut reader = Reader {
        blocks: vec![],
        ids: BTreeSet::new(),
    };
    reader.visit(ast, "", None)?;
    if children(ast).is_empty() {
        reader.blocks.push(SourceBlock {
            address: "/empty".into(),
            kind: "empty".into(),
            start_utf8: source.len(),
            end_utf8: source.len(),
            list_item_address: None,
            id: None,
        });
    }
    for id in required {
        if !crate::manuscript::uuid4(id) {
            return Err(error("IDENTITY_INVALID", *id));
        }
        if !reader.ids.contains(*id) {
            return Err(error("IDENTITY_MISSING", *id));
        }
    }
    Ok(SourceDocument {
        source: source.into(),
        blocks: reader.blocks,
    })
}
/// Patches use the captured base, half-open UTF-8 ranges, and reject scalar splits.
pub fn apply_patches(
    document: &SourceDocument,
    expected: &[u8],
    patches: &[SourcePatch],
) -> Result<Vec<u8>> {
    if document.source.as_bytes() != expected {
        return Err(error("SOURCE_BASE_MISMATCH", "source"));
    }
    let mut patches = patches.iter().collect::<Vec<_>>();
    patches.sort_by_key(|p| (p.start, p.end));
    let mut output = String::new();
    let mut cursor = 0;
    let mut previous = None;
    for patch in patches {
        if patch.end < patch.start
            || !document.source.is_char_boundary(patch.start)
            || !document.source.is_char_boundary(patch.end)
        {
            return Err(error("SOURCE_RANGE_INVALID", "patch"));
        }
        if previous.is_some_and(|(s, e)| patch.start < e || patch.start == s) {
            return Err(error("SOURCE_PATCH_OVERLAP", "patch"));
        }
        output.push_str(&document.source[cursor..patch.start]);
        output.push_str(&patch.replacement);
        cursor = patch.end;
        previous = Some((patch.start, patch.end));
    }
    output.push_str(&document.source[cursor..]);
    if output.len() > crate::manuscript::MAX_DOCUMENT_BYTES {
        return Err(error("DOCUMENT_TOO_LARGE", "source"));
    }
    Ok(output.into_bytes())
}
/// Metadata-free AST proof retains spread flags, raw HTML, and code payloads.
fn meaning_ast(ast: &Value) -> Result<Value> {
    fn clean(node: &Value) -> Result<Option<Value>> {
        if marker(node)?.is_some() {
            return Ok(None);
        }
        let mut value = node.clone();
        if let Some(object) = value.as_object_mut() {
            object.remove("position");
            if node["children"].is_array() {
                object.insert(
                    "children".into(),
                    Value::Array(
                        children(node)
                            .iter()
                            .map(clean)
                            .collect::<Result<Vec<_>>>()?
                            .into_iter()
                            .flatten()
                            .collect(),
                    ),
                );
            }
        }
        Ok(Some(value))
    }
    Ok(clean(ast)?.expect("root"))
}
pub fn source_meaning(input: &[u8]) -> Result<Value> {
    let source = std::str::from_utf8(input).map_err(|_| error("SOURCE_UTF8_INVALID", "source"))?;
    meaning_ast(&parse(source)?)
}
fn at_address<'a>(root: &'a Value, address: &str) -> &'a Value {
    address
        .split('/')
        .filter(|s| !s.is_empty())
        .fold(root, |node, part| {
            &children(node)[part.parse::<usize>().expect("native address")]
        })
}
fn continuation(prefix: &str) -> String {
    // This only constructs indentation after the parser has established ownership.
    let bytes = prefix.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let mut stop = index;
        if b"-+*".contains(&bytes[index]) {
            stop += 1;
        } else if bytes[index].is_ascii_digit() {
            while stop < bytes.len() && bytes[stop].is_ascii_digit() {
                stop += 1;
            }
            if stop < bytes.len() && b".)".contains(&bytes[stop]) {
                stop += 1;
            } else {
                stop = index;
            }
        }
        if stop > index && stop < bytes.len() && b" \t".contains(&bytes[stop]) {
            while stop < bytes.len() && b" \t".contains(&bytes[stop]) {
                stop += 1;
            }
            output.push_str(&" ".repeat(stop - index));
            index = stop;
        } else {
            let c = prefix[index..].chars().next().expect("scalar");
            output.push(c);
            index += c.len_utf8();
        }
    }
    output
}
fn identity_patch(
    document: &SourceDocument,
    ast: &Value,
    block: &SourceBlock,
    id: &str,
    eol: &str,
) -> Result<SourcePatch> {
    let address = block.address.as_str();
    let source = &document.source;
    let mut offset = block.start_utf8;
    let insertion;
    if block.kind == "empty" {
        let parent = at_address(
            ast,
            if address == "/empty" {
                ""
            } else {
                address.strip_suffix("/empty").expect("empty address")
            },
        );
        if kind(parent) == "root" {
            offset = source.len();
            insertion = format!(
                "{}{EMPTY}{id} -->{eol}",
                if !source.is_empty() && !source.ends_with('\n') {
                    eol
                } else {
                    ""
                }
            );
        } else if let Some(child) = children(parent).first() {
            offset = start(child);
            let line = source[..offset].rfind('\n').map_or(0, |n| n + 1);
            insertion = format!(
                "{EMPTY}{id} -->{eol}{}",
                continuation(&source[line..offset])
            );
        } else {
            offset = end(parent);
            insertion = format!(" {EMPTY}{id} -->");
        }
    } else if matches!(block.kind.as_str(), "paragraph" | "heading") {
        if address.split('/').count() <= 2 {
            insertion = format!("{BLOCK}{id} -->{eol}{eol}");
        } else {
            let mut leading = "";
            let mut trailing = "";
            if block.kind == "paragraph" {
                offset = block.end_utf8 - source[block.start_utf8..block.end_utf8].len()
                    + source[block.start_utf8..block.end_utf8]
                        .trim_end_matches([' ', '\t'])
                        .len();
            } else {
                let heading = at_address(ast, address);
                if let Some(last) = children(heading).last() {
                    offset = end(last);
                } else {
                    let raw = &source[offset..block.end_utf8];
                    let hashes = raw.bytes().take_while(|b| *b == b'#').count();
                    if (1..=6).contains(&hashes)
                        && (hashes == raw.len() || raw.as_bytes()[hashes].is_ascii_whitespace())
                    {
                        offset += hashes
                            + raw[hashes..]
                                .bytes()
                                .take_while(|b| b" \t".contains(b))
                                .count();
                        if !source[..offset].ends_with([' ', '\t']) {
                            leading = " ";
                        }
                        let tail = &source[offset..block.end_utf8];
                        if tail.starts_with('#')
                            && tail
                                .trim_end_matches([' ', '\t'])
                                .bytes()
                                .all(|b| b == b'#')
                        {
                            trailing = " ";
                        }
                    }
                }
            }
            insertion = format!("{leading}{BLOCK}{id} -->{trailing}");
        }
    } else {
        let line = source[..offset].rfind('\n').map_or(0, |n| n + 1);
        insertion = format!(
            "{BLOCK}{id} -->{eol}{}",
            continuation(&source[line..offset])
        );
    }
    Ok(SourcePatch {
        start: offset,
        end: offset,
        replacement: insertion,
    })
}
/// Batch insert identities against one captured syntax tree and prove meaning
/// and required bindings once. Patches never use positions from an earlier edit.
pub fn insert_identities(
    document: &SourceDocument,
    bindings: &[(String, String)],
) -> Result<SourceDocument> {
    if bindings.is_empty() {
        return Ok(document.clone());
    }
    let ast = parse(&document.source)?;
    let eol = if document.source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let blocks = document
        .blocks
        .iter()
        .map(|block| (block.address.as_str(), block))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut ids = document
        .blocks
        .iter()
        .filter_map(|block| block.id.as_deref())
        .collect::<BTreeSet<_>>();
    let mut patches = Vec::with_capacity(bindings.len());
    for (address, id) in bindings {
        if !crate::manuscript::uuid4(id) {
            return Err(error("IDENTITY_INVALID", id));
        }
        if !ids.insert(id.as_str()) {
            return Err(error("IDENTITY_DUPLICATE", id));
        }
        let block = blocks
            .get(address.as_str())
            .filter(|block| block.id.is_none())
            .ok_or_else(|| error("IDENTITY_AMBIGUOUS", address))?;
        patches.push(identity_patch(document, &ast, block, id, eol)?);
    }
    let candidate = apply_patches(document, document.source.as_bytes(), &patches)?;
    let required = ids.into_iter().collect::<Vec<_>>();
    let candidate_source =
        std::str::from_utf8(&candidate).map_err(|_| error("SOURCE_UTF8_INVALID", "source"))?;
    let candidate_ast = parse(candidate_source)?;
    let result = read_parsed(candidate_source, &candidate_ast, &required)
        .map_err(|_| error("IDENTITY_PLACEMENT_UNSUPPORTED", "batch"))?;
    if meaning_ast(&ast)? != meaning_ast(&candidate_ast)? {
        return Err(error("IDENTITY_PLACEMENT_UNSUPPORTED", "batch"));
    }
    Ok(result)
}
/// Insert one identity using the same placement and proof as batch adoption.
pub fn insert_identity(
    document: &SourceDocument,
    address: &str,
    id: &str,
) -> Result<SourceDocument> {
    insert_identities(document, &[(address.into(), id.into())])
}

/// Unsupported leaves retain their native identity and raw bytes.
/// Simple list-item paragraphs retain the existing list kind/depth semantics.
pub fn project(document: &SourceDocument) -> Result<Vec<crate::contracts::NewBlock>> {
    use crate::contracts::*;
    fn inline(node: &Value, marks: &[Mark], runs: &mut Vec<TextRun>) -> Result<bool> {
        if marker(node)?.is_some() {
            return Ok(true);
        }
        let text = match kind(node) {
            "text" | "inlineCode" => node["value"].as_str().unwrap_or("").to_owned(),
            "break" => "\n".into(),
            "strong" | "emphasis" | "link" => {
                let mut marks = marks.to_vec();
                marks.push(Mark {
                    r#type: match kind(node) {
                        "strong" => MarkType::Bold,
                        "emphasis" => MarkType::Italic,
                        _ => MarkType::Link,
                    },
                    href: if kind(node) == "link" {
                        Some(node["url"].as_str().unwrap_or("").into())
                    } else {
                        None
                    },
                });
                for child in children(node) {
                    if !inline(child, &marks, runs)? {
                        return Ok(false);
                    }
                }
                return Ok(true);
            }
            _ => return Ok(false),
        };
        let mut marks = marks.to_vec();
        if kind(node) == "inlineCode" {
            marks.push(Mark {
                r#type: MarkType::Code,
                href: None,
            });
        }
        runs.push(TextRun { text, marks });
        Ok(true)
    }
    let ast = parse(&document.source)?;
    let mut output = vec![];
    let mut item_addresses = std::collections::BTreeMap::new();
    for block in &document.blocks {
        let Some(id) = &block.id else {
            continue;
        };
        if !matches!(block.kind.as_str(), "paragraph" | "heading" | "empty") {
            continue;
        }
        let node_address = block
            .address
            .strip_suffix("/empty")
            .unwrap_or(&block.address);
        let parts = node_address
            .split('/')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let mut parent = &ast;
        let mut lists = vec![];
        let mut quoted = false;
        for part in &parts[..parts.len().saturating_sub(1)] {
            parent = &children(parent)[part.parse::<usize>().expect("native address")];
            if kind(parent) == "list" {
                lists.push(parent);
            }
            if kind(parent) == "blockquote" {
                quoted = true;
            }
        }
        if quoted {
            continue;
        }
        let item = block
            .list_item_address
            .as_ref()
            .map(|address| at_address(&ast, address));
        if let Some(item) = item {
            let leaves = children(item)
                .iter()
                .filter(|node| !container(node) && !matches!(marker(node), Ok(Some(_))))
                .collect::<Vec<_>>();
            if leaves.len() > 1
                || leaves.first().is_some_and(|node| kind(node) != "paragraph")
                || lists.len() > 4
                || block.kind == "heading"
            {
                continue;
            }
        } else if parts.len() != 1 {
            continue;
        }
        let mut runs = vec![];
        let node = at_address(&ast, node_address);
        let mut supported = true;
        for child in children(node) {
            supported &= inline(child, &[], &mut runs)?;
        }
        if supported {
            if let Some(address) = &block.list_item_address {
                item_addresses.insert(id.clone(), address.clone());
            }
            output.push(NewBlock {
                id: id.clone(),
                kind: if item.is_some() {
                    BlockKind::Listitem
                } else if block.kind == "heading" {
                    BlockKind::Heading
                } else {
                    BlockKind::Paragraph
                },
                attrs: BlockAttrs {
                    level: if block.kind == "heading" {
                        node["depth"].as_i64()
                    } else {
                        None
                    },
                    list_kind: lists.last().map(|list| {
                        if list["ordered"] == true {
                            BlockAttrsListKind::Ordered
                        } else {
                            BlockAttrsListKind::Bullet
                        }
                    }),
                    depth: item.map(|_| lists.len().saturating_sub(1) as i64),
                },
                runs,
            });
        }
    }
    // The canonical validator also rejects unsupported link schemes and duplicate
    // marks. Preserve such leaves as raw, rather than turning them into a failure
    // to read the creative source.
    output.retain_mut(|block| {
        let mut state = ManuscriptState {
            manuscript_id: "11111111-1111-4111-8111-111111111111".into(),
            schema_version: 1,
            workspace_stage: ManuscriptStateWorkspaceStage::Draft,
            working_revision: 0,
            blocks: vec![Block {
                id: block.id.clone(),
                revision: 1,
                kind: block.kind.clone(),
                attrs: block.attrs.clone(),
                runs: block.runs.clone(),
            }],
        };
        // A list child can be individually deeper than zero; validate against
        // a temporary root depth and retain its actual container depth.
        if block.kind == BlockKind::Listitem {
            state.blocks[0].attrs.depth = Some(0);
        }
        if crate::manuscript::normalize(&mut state).is_err() {
            return false;
        }
        block.runs = state.blocks.remove(0).runs;
        true
    });
    // A supported child cannot stand in for an unrepresentable ancestor. Keep
    // that subtree raw rather than fabricating a parent or changing its depth.
    let mut supported_items = BTreeSet::new();
    output.retain(|block| {
        let Some(address) = item_addresses.get(&block.id) else {
            return true;
        };
        if block.attrs.depth.unwrap_or(0) > 0 {
            let parent = address
                .rsplit_once('/')
                .and_then(|(list, _)| list.rsplit_once('/'))
                .map(|(item, _)| item);
            if parent.is_none_or(|parent| !supported_items.contains(parent)) {
                return false;
            }
        }
        supported_items.insert(address.clone());
        true
    });
    Ok(output)
}

/// A standalone root leaf's complete owned syntax, including its preceding
/// identity comment. Container structure must never be deleted as a side effect.
pub fn root_leaf_range(document: &SourceDocument, id: &str) -> Result<Option<(usize, usize)>> {
    let ast = parse(&document.source)?;
    let Some(block) = document
        .blocks
        .iter()
        .find(|block| block.id.as_deref() == Some(id))
    else {
        return Ok(None);
    };
    if block.address.split('/').count() != 2 {
        return Ok(None);
    }
    let index = block.address[1..]
        .parse::<usize>()
        .map_err(|_| error("IDENTITY_AMBIGUOUS", id))?;
    let nodes = children(&ast);
    let node = &nodes[index];
    let previous = index.checked_sub(1).and_then(|index| nodes.get(index));
    let owned_start = if let Some(previous) =
        previous.filter(|node| matches!(marker(node), Ok(Some(value)) if value == id))
    {
        start(previous)
    } else {
        start(node)
    };
    Ok(Some((owned_start, end(node))))
}

/// Prefix syntax for a simple list leaf on its item's first line. Changing a
/// continuation line or a complex item requires a richer semantic operation.
pub fn list_prefix_range(document: &SourceDocument, id: &str) -> Result<Option<(usize, usize)>> {
    let ast = parse(&document.source)?;
    let Some(block) = document
        .blocks
        .iter()
        .find(|block| block.id.as_deref() == Some(id))
    else {
        return Ok(None);
    };
    let Some(address) = &block.list_item_address else {
        return Ok(None);
    };
    let item = at_address(&ast, address);
    let line = document.source[..block.start_utf8]
        .rfind('\n')
        .map_or(0, |offset| offset + 1);
    if start(item) < line {
        return Ok(None);
    }
    Ok(Some((line, block.start_utf8)))
}

/// Prove that edits are confined to the same supported leaves. Everything
/// outside their owned spans (including unknown syntax and container prefixes)
/// is compared byte for byte. None means the impact cannot be narrowed safely.
pub fn known_leaf_change_scope(
    before: &SourceDocument,
    after: &SourceDocument,
    ids: &BTreeSet<String>,
) -> Result<Option<BTreeSet<String>>> {
    fn capture(
        document: &SourceDocument,
        ids: &BTreeSet<String>,
    ) -> Result<(String, std::collections::BTreeMap<String, String>)> {
        let ast = parse(&document.source)?;
        let mut ranges = Vec::with_capacity(ids.len());
        for block in &document.blocks {
            let Some(id) = block.id.as_ref().filter(|id| ids.contains(*id)) else {
                continue;
            };
            let mut owned_start = block.start_utf8;
            if block.address.split('/').count() == 2 {
                let index = block.address[1..]
                    .parse::<usize>()
                    .map_err(|_| error("IDENTITY_AMBIGUOUS", id))?;
                if let Some(previous) = index
                    .checked_sub(1)
                    .and_then(|index| children(&ast).get(index))
                    .filter(|node| matches!(marker(node),Ok(Some(value)) if value==id))
                {
                    owned_start = start(previous);
                }
            }
            ranges.push((owned_start, block.end_utf8, id));
        }
        ranges.sort_by_key(|(start, _, _)| *start);
        let mut cursor = 0;
        let mut skeleton = String::new();
        let mut raw = std::collections::BTreeMap::new();
        for (start, end, id) in ranges {
            if start < cursor {
                return Err(error("IDENTITY_AMBIGUOUS", id));
            }
            skeleton.push_str(&document.source[cursor..start]);
            skeleton.push_str("[scenesparrow-owned:");
            skeleton.push_str(id);
            skeleton.push(']');
            raw.insert(id.clone(), document.source[start..end].to_owned());
            cursor = end;
        }
        skeleton.push_str(&document.source[cursor..]);
        Ok((skeleton, raw))
    }
    let (before_skeleton, before_raw) = capture(before, ids)?;
    let (after_skeleton, after_raw) = capture(after, ids)?;
    if before_raw.len() != ids.len()
        || after_raw.len() != ids.len()
        || before_skeleton != after_skeleton
    {
        return Ok(None);
    }
    Ok(Some(
        ids.iter()
            .filter(|id| before_raw.get(*id) != after_raw.get(*id))
            .cloned()
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus(name: &str) -> Vec<Value> {
        serde_json::from_str(match name {
            "read" => {
                include_str!("../../../tests/fixtures/open-project/identity-read-corpus.json")
            }
            _ => include_str!("../../../tests/fixtures/open-project/identity-corpus.json"),
        })
        .unwrap()
    }
    #[test]
    fn native_spans_match_frozen_javascript_codec() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../tests/fixtures/open-project/native-span-corpus.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let doc = read_source(fixture["source"].as_str().unwrap().as_bytes(), &[]).unwrap();
            let mut actual = serde_json::to_value(doc.blocks).unwrap();
            for block in actual.as_array_mut().unwrap() {
                for key in ["id", "listItemAddress"] {
                    if block[key].is_null() {
                        block.as_object_mut().unwrap().remove(key);
                    }
                }
            }
            assert_eq!(actual, fixture["blocks"], "{}", fixture["name"]);
        }
    }
    #[test]
    fn native_frozen_identity_read_agreement() {
        for fixture in corpus("insert").into_iter().chain(corpus("read")) {
            let source = fixture["boundSource"]
                .as_str()
                .or_else(|| fixture["source"].as_str())
                .unwrap();
            let required = fixture["requiredIds"]
                .as_array()
                .map(|ids| ids.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>())
                .unwrap_or_default();
            let result = read_source(source.as_bytes(), &required);
            if let Some(code) = fixture["error"].as_str() {
                assert_eq!(result.unwrap_err().code, code, "{}", fixture["name"]);
            } else {
                let document = result.unwrap_or_else(|e| panic!("{}: {e}", fixture["name"]));
                assert_eq!(
                    serde_json::to_value(
                        document
                            .blocks
                            .iter()
                            .filter_map(|b| b.id.as_ref())
                            .collect::<Vec<_>>()
                    )
                    .unwrap(),
                    fixture["expectedIds"],
                    "{}",
                    fixture["name"]
                );
                assert_eq!(
                    serde_json::to_value(
                        document.blocks.iter().map(|b| &b.kind).collect::<Vec<_>>()
                    )
                    .unwrap(),
                    fixture["expectedKinds"],
                    "{}",
                    fixture["name"]
                );
                assert_eq!(
                    apply_patches(&document, source.as_bytes(), &[]).unwrap(),
                    source.as_bytes()
                );
                for block in &document.blocks {
                    assert!(source.is_char_boundary(block.start_utf8));
                    assert!(source.is_char_boundary(block.end_utf8));
                }
            }
        }
    }
    #[test]
    fn native_frozen_insertion_and_meaning_agreement() {
        for fixture in corpus("insert") {
            let source = fixture["source"].as_str().unwrap();
            let mut document = read_source(source.as_bytes(), &[]).unwrap();
            let bindings = document
                .blocks
                .iter()
                .filter(|block| block.id.is_none())
                .zip(fixture["expectedIds"].as_array().unwrap())
                .map(|(block, id)| (block.address.clone(), id.as_str().unwrap().to_owned()))
                .collect::<Vec<_>>();
            let batched = insert_identities(&document, &bindings)
                .unwrap_or_else(|error| panic!("batch {}: {error}", fixture["name"]));
            assert_eq!(
                batched.source,
                fixture["boundSource"].as_str().unwrap(),
                "batch {}",
                fixture["name"]
            );
            for id in fixture["expectedIds"].as_array().unwrap() {
                let address = document
                    .blocks
                    .iter()
                    .find(|b| b.id.is_none())
                    .unwrap()
                    .address
                    .clone();
                document = insert_identity(&document, &address, id.as_str().unwrap())
                    .unwrap_or_else(|e| panic!("{}: {e}", fixture["name"]));
            }
            assert_eq!(
                document.source,
                fixture["boundSource"].as_str().unwrap(),
                "{}",
                fixture["name"]
            );
            assert_eq!(
                source_meaning(source.as_bytes()).unwrap(),
                source_meaning(document.source.as_bytes()).unwrap(),
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn batch_binding_sanity_at_one_and_ten_thousand_leaves() {
        for count in [1000, 10000] {
            let source = (0..count)
                .map(|index| format!("Paragraph {index} 中文 🐦.\n\n"))
                .collect::<String>();
            let start = std::time::Instant::now();
            let document = read_source(source.as_bytes(), &[]).unwrap();
            let read_elapsed = start.elapsed();
            let bindings = document
                .blocks
                .iter()
                .enumerate()
                .map(|(index, block)| {
                    (
                        block.address.clone(),
                        format!("11111111-1111-4111-8111-{index:012x}"),
                    )
                })
                .collect::<Vec<_>>();
            let bound = insert_identities(&document, &bindings).unwrap();
            assert_eq!(bound.blocks.len(), count);
            assert!(bound.blocks.iter().all(|block| block.id.is_some()));
            let total_elapsed = start.elapsed();
            let parser_start = std::time::Instant::now();
            let _bound_ast = parse(&bound.source).unwrap();
            let bound_parse_elapsed = parser_start.elapsed();
            eprintln!(
                "batch-binding leaves={count} sourceBytes={} boundBytes={} readMs={} totalMs={} boundParseMs={}",
                source.len(),
                bound.source.len(),
                read_elapsed.as_millis(),
                total_elapsed.as_millis(),
                bound_parse_elapsed.as_millis()
            );
        }
    }
    #[test]
    fn byte_ranges_reject_scalar_splits_stale_overlap_and_invalid_utf8() {
        assert_eq!(
            read_source(&[255], &[]).unwrap_err().code,
            "SOURCE_UTF8_INVALID"
        );
        let doc = read_source("a雀👩‍💻z".as_bytes(), &[]).unwrap();
        let patch = |start, end| SourcePatch {
            start,
            end,
            replacement: "X".into(),
        };
        for p in [patch(2, 3), patch(0, 100), patch(4, 1)] {
            assert_eq!(
                apply_patches(&doc, doc.source.as_bytes(), &[p])
                    .unwrap_err()
                    .code,
                "SOURCE_RANGE_INVALID"
            );
        }
        assert_eq!(
            apply_patches(&doc, b"stale", &[]).unwrap_err().code,
            "SOURCE_BASE_MISMATCH"
        );
        for patches in [
            vec![patch(0, 4), patch(1, 4)],
            vec![patch(0, 0), patch(0, 0)],
        ] {
            assert_eq!(
                apply_patches(&doc, doc.source.as_bytes(), &patches)
                    .unwrap_err()
                    .code,
                "SOURCE_PATCH_OVERLAP"
            );
        }
        assert_eq!(
            apply_patches(&doc, doc.source.as_bytes(), &[patch(1, 4)]).unwrap(),
            "aX👩‍💻z".as_bytes()
        );
    }
}
