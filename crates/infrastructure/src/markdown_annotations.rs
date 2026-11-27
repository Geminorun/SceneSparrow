//! Durable source anchors. Original evidence survives document/sidecar interruption.
use super::markdown_projects::{MarkdownProjects, Result, digest, io, read, regular};
use atomic_write_file::AtomicWriteFile;
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use scenesparrow_domain::contracts::*;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::ops::Range;
use uuid::Uuid;

pub(super) const SIDECAR_LIMIT: usize = 4 * 1024 * 1024;
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Locks {
    locks: Vec<MarkdownLock>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Comments {
    comments: Vec<MarkdownComment>,
}
struct Block {
    range: Range<usize>,
    structure: String,
    fingerprint: String,
}
fn blocks(text: &str) -> Vec<Block> {
    let mut output = vec![];
    let mut headings: Vec<(usize, String)> = vec![];
    let mut lists: Vec<String> = vec![];
    let mut items: Vec<String> = vec![];
    let bom = usize::from(text.starts_with('\u{feff}')) * 3;
    for (event, range) in Parser::new(&text[bom..]).into_offset_iter() {
        let start = range.start + bom;
        let end = text[..range.end + bom].trim_end_matches(['\r', '\n']).len();
        let range = start..end;
        let kind = match event {
            Event::Start(Tag::Heading { level, .. }) => {
                let level = level as usize;
                while headings.last().is_some_and(|(old, _)| *old >= level) {
                    headings.pop();
                }
                Some(format!("heading:{level}"))
            }
            Event::Start(Tag::List(ordered)) => {
                lists.push(
                    if ordered.is_some() {
                        "ordered"
                    } else {
                        "bullet"
                    }
                    .into(),
                );
                None
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
                None
            }
            Event::Start(Tag::Item) => Some("item".into()),
            Event::End(TagEnd::Item) => {
                items.pop();
                None
            }
            Event::Start(Tag::Paragraph) if items.is_empty() => Some("paragraph".into()),
            _ => None,
        };
        if let Some(kind) = kind {
            let structure = format!(
                "{}/{}/{}/{kind}",
                headings
                    .iter()
                    .map(|(_, id)| id.as_str())
                    .collect::<Vec<_>>()
                    .join("/"),
                lists.join("/"),
                items.join("/")
            );
            if let Some(level) = kind.strip_prefix("heading:") {
                headings.push((
                    level.parse().unwrap(),
                    format!("h{level}:{}", digest(&text[range.clone()])),
                ));
            }
            if kind == "item" {
                items.push(format!(
                    "i:{}",
                    digest(text[range.clone()].lines().next().unwrap_or(""))
                ));
            }
            output.push(Block {
                fingerprint: digest(&text[range.clone()]),
                range,
                structure,
            });
        }
    }
    output.sort_by_key(|block| block.range.start);
    output
}
// A renamed ancestor may retain its place; an existing different ancestor cannot adopt the lock.
fn compatible(expected: &str, actual: &str, parsed: &[Block]) -> bool {
    let expected: Vec<_> = expected.split('/').collect();
    let actual: Vec<_> = actual.split('/').collect();
    expected.len() == actual.len()
        && expected.iter().zip(actual).all(|(old, new)| {
            if *old == new {
                return true;
            }
            let Some((old_kind, old_digest)) = old.split_once(':') else {
                return false;
            };
            let Some((new_kind, _)) = new.split_once(':') else {
                return false;
            };
            (old_kind.starts_with('h') || old_kind == "i")
                && old_kind == new_kind
                && !parsed.iter().any(|b| {
                    b.fingerprint == old_digest || b.structure.split('/').any(|part| part == *old)
                })
        })
}
fn anchor(
    doc: &MarkdownDocument,
    parsed: &[Block],
    range: Range<usize>,
    structure: String,
) -> Result<MarkdownAnchor> {
    let quote = doc
        .text
        .get(range.clone())
        .filter(|v| !v.is_empty())
        .ok_or("MARKDOWN_ANCHOR_INVALID")?;
    Ok(MarkdownAnchor {
        source_revision: doc.revision.clone().ok_or("MARKDOWN_CONFLICT")?,
        start: range.start as i64,
        end: range.end as i64,
        fingerprint: digest(quote),
        quote: quote.into(),
        structure,
        before: parsed
            .iter()
            .filter(|b| b.range.end <= range.start)
            .rev()
            .take(16)
            .map(|b| b.fingerprint.clone())
            .collect(),
        after: parsed
            .iter()
            .filter(|b| b.range.start >= range.end)
            .take(16)
            .map(|b| b.fingerprint.clone())
            .collect(),
        resolved_start: None,
        resolved_end: None,
    })
}
fn locate(
    text: &str,
    revision: &str,
    parsed: &[Block],
    a: &MarkdownAnchor,
    lock: bool,
) -> Option<Range<usize>> {
    if a.quote.is_empty() || digest(&a.quote) != a.fingerprint {
        return None;
    }
    let matches: Vec<_> = if lock {
        parsed
            .iter()
            .filter(|b| {
                b.fingerprint == a.fingerprint && compatible(&a.structure, &b.structure, parsed)
            })
            .map(|b| b.range.clone())
            .collect()
    } else {
        text.match_indices(&a.quote)
            .map(|(start, _)| start..start + a.quote.len())
            .collect()
    };
    let mut neighbors = std::collections::HashMap::new();
    for b in parsed
        .iter()
        .filter(|b| a.before.contains(&b.fingerprint) || a.after.contains(&b.fingerprint))
    {
        neighbors
            .entry(b.fingerprint.as_str())
            .and_modify(|value| *value = None)
            .or_insert(Some(b));
    }
    let matches: Vec<_> = matches
        .into_iter()
        .filter(|range| {
            neighbors.iter().all(|(fingerprint, block)| {
                let Some(b) = block else {
                    return true;
                };
                b.range == *range
                    || !(a.before.iter().any(|v| v == fingerprint) && b.range.start >= range.start
                        || a.after.iter().any(|v| v == fingerprint) && b.range.end <= range.end)
            })
        })
        .collect();
    // An exact offset is not proof after a revision change: duplicate targets remain ambiguous.
    let range = if revision == a.source_revision {
        let range = a.start as usize..a.end as usize;
        if text.get(range.clone()) != Some(a.quote.as_str()) {
            return None;
        }
        range
    } else {
        if matches.len() != 1 {
            return None;
        }
        matches[0].clone()
    };
    if lock {
        if !parsed
            .iter()
            .any(|b| b.range == range && compatible(&a.structure, &b.structure, parsed))
        {
            return None;
        }
        // Uniquely surviving original neighbours also fence structural relocation.
        if revision != a.source_revision
            && neighbors.iter().any(|(fingerprint, block)| {
                let Some(b) = block else {
                    return false;
                };
                b.range != range
                    && (a.before.iter().any(|v| v == fingerprint) && b.range.start >= range.start
                        || a.after.iter().any(|v| v == fingerprint) && b.range.end <= range.end)
            })
        {
            return None;
        }
    }
    Some(range)
}
fn resolve(a: &mut MarkdownAnchor, text: &str, revision: &str, parsed: &[Block], lock: bool) {
    let range = locate(text, revision, parsed, a, lock);
    a.resolved_start = range.as_ref().map(|v| v.start as i64);
    a.resolved_end = range.map(|v| v.end as i64);
}
impl MarkdownProjects {
    fn sidecar<T: serde::de::DeserializeOwned + Default>(&self, id: &str, name: &str) -> Result<T> {
        let path = self.validated_directory(id)?.join(name);
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(_) => Err("MARKDOWN_ANNOTATIONS_UNAVAILABLE"),
            Ok(_) => serde_json::from_slice(
                &read(&path, SIDECAR_LIMIT).map_err(|_| "MARKDOWN_ANNOTATIONS_UNAVAILABLE")?,
            )
            .map_err(|_| "MARKDOWN_ANNOTATIONS_UNAVAILABLE"),
        }
    }
    fn write_sidecar(&self, id: &str, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value).map_err(|_| "MARKDOWN_ANNOTATIONS_UNAVAILABLE")?;
        if bytes.len() > SIDECAR_LIMIT {
            return Err("MARKDOWN_ANNOTATIONS_UNAVAILABLE");
        }
        let path = self.validated_directory(id)?.join(name);
        if std::fs::symlink_metadata(&path).is_ok() {
            regular(&path, false)?;
        }
        let mut file = io(AtomicWriteFile::open(path))?;
        io(file.write_all(&bytes))?;
        io(file.commit())
    }
    pub(super) fn annotations_inner(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
    ) -> Result<MarkdownAnnotations> {
        let doc = self.read_document_inner(id, kind.clone())?;
        let parsed = blocks(&doc.text);
        let mut locks: Locks = self.sidecar(id, "locks.json")?;
        let mut comments: Comments = self.sidecar(id, "comments.json")?;
        locks.locks.retain(|l| l.kind == kind);
        comments.comments.retain(|c| c.kind == kind);
        for lock in &mut locks.locks {
            for a in &mut lock.anchors {
                resolve(
                    a,
                    &doc.text,
                    doc.revision.as_deref().unwrap_or(""),
                    &parsed,
                    true,
                );
            }
        }
        for comment in &mut comments.comments {
            resolve(
                &mut comment.anchor,
                &doc.text,
                doc.revision.as_deref().unwrap_or(""),
                &parsed,
                false,
            );
        }
        Ok(MarkdownAnnotations {
            locks: locks.locks,
            comments: comments.comments,
        })
    }
    pub fn annotations(&self, id: &str, kind: MarkdownDocumentKind) -> Result<MarkdownAnnotations> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        self.annotations_inner(id, kind)
    }
    pub(super) fn protect(&self, id: &str, current: &MarkdownDocument, text: &str) -> Result<()> {
        let locks: Locks = self.sidecar(id, "locks.json")?;
        if !locks.locks.iter().any(|lock| lock.kind == current.kind) {
            return Ok(());
        }
        let old_blocks = blocks(&current.text);
        let new_blocks = blocks(text);
        let new_revision = digest(text);
        fn unique(blocks: &[Block]) -> std::collections::HashMap<&str, Option<&Block>> {
            let mut map = std::collections::HashMap::new();
            for b in blocks {
                map.entry(b.fingerprint.as_str())
                    .and_modify(|value| *value = None)
                    .or_insert(Some(b));
            }
            map
        }
        let old_unique = unique(&old_blocks);
        let new_unique = unique(&new_blocks);
        for lock in locks.locks.iter().filter(|l| l.kind == current.kind) {
            if lock.anchors.is_empty() {
                return Err("MARKDOWN_LOCK_CONFLICT");
            }
            for a in &lock.anchors {
                let old_range = locate(
                    &current.text,
                    current.revision.as_deref().unwrap_or(""),
                    &old_blocks,
                    a,
                    true,
                )
                .ok_or("MARKDOWN_LOCK_CONFLICT")?;
                let new_range =
                    locate(text, &new_revision, &new_blocks, a, true).ok_or("MARKDOWN_LOCKED")?;
                for (fingerprint, block) in &old_unique {
                    let (Some(block), Some(Some(next))) = (block, new_unique.get(fingerprint))
                    else {
                        continue;
                    };
                    if (block.range.end <= old_range.start && next.range.start >= new_range.start)
                        || (block.range.start >= old_range.end && next.range.end <= new_range.end)
                    {
                        return Err("MARKDOWN_LOCKED");
                    }
                }
                let old = old_blocks
                    .iter()
                    .find(|b| b.range == old_range)
                    .ok_or("MARKDOWN_LOCK_CONFLICT")?;
                let new = new_blocks
                    .iter()
                    .find(|b| b.range == new_range)
                    .ok_or("MARKDOWN_LOCKED")?;
                if !compatible(&old.structure, &new.structure, &new_blocks)
                    || !compatible(&new.structure, &old.structure, &old_blocks)
                {
                    return Err("MARKDOWN_LOCKED");
                }
            }
        }
        Ok(())
    }
    pub fn annotate(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        action: MarkdownAnnotationAction,
    ) -> Result<MarkdownAnnotations> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let doc = self.read_document_inner(id, kind.clone())?;
        let check = |revision: &str| {
            if doc.revision.as_deref() == Some(revision) {
                Ok(())
            } else {
                Err("MARKDOWN_CONFLICT")
            }
        };
        // Validate both sidecars before any mutation so a failed response cannot conceal a successful write.
        self.annotations_inner(id, kind.clone())?;
        match action {
            MarkdownAnnotationAction::Lock { revision, ranges } => {
                check(&revision)?;
                if ranges.is_empty() || ranges.len() > 1000 {
                    return Err("MARKDOWN_ANCHOR_INVALID");
                }
                let parsed = blocks(&doc.text);
                let mut anchors = vec![];
                for range in ranges {
                    let b = parsed
                        .iter()
                        .find(|b| {
                            b.range.start as i64 == range.start && b.range.end as i64 == range.end
                        })
                        .ok_or("MARKDOWN_ANCHOR_INVALID")?;
                    let a = anchor(&doc, &parsed, b.range.clone(), b.structure.clone())?;
                    if locate(&doc.text, revision.as_str(), &parsed, &a, true).is_none() {
                        return Err("MARKDOWN_LOCK_CONFLICT");
                    }
                    anchors.push(a);
                }
                let mut data: Locks = self.sidecar(id, "locks.json")?;
                data.locks.push(MarkdownLock {
                    id: Uuid::new_v4().to_string(),
                    kind: kind.clone(),
                    anchors,
                });
                self.write_sidecar(id, "locks.json", &data)?;
            }
            MarkdownAnnotationAction::Unlock { id: lock_id } => {
                let mut data: Locks = self.sidecar(id, "locks.json")?;
                data.locks.retain(|v| v.id != lock_id || v.kind != kind);
                self.write_sidecar(id, "locks.json", &data)?;
            }
            MarkdownAnnotationAction::Comment {
                revision,
                range,
                text,
            } => {
                check(&revision)?;
                if text.trim().is_empty() || text.len() > 16 * 1024 {
                    return Err("MARKDOWN_ANCHOR_INVALID");
                }
                let a = anchor(
                    &doc,
                    &blocks(&doc.text),
                    range.start as usize..range.end as usize,
                    "selection".into(),
                )?;
                let mut data: Comments = self.sidecar(id, "comments.json")?;
                data.comments.push(MarkdownComment {
                    id: Uuid::new_v4().to_string(),
                    kind: kind.clone(),
                    anchor: a,
                    text,
                    status: MarkdownCommentStatus::Open,
                });
                self.write_sidecar(id, "comments.json", &data)?;
            }
            MarkdownAnnotationAction::Edit {
                id: comment_id,
                revision,
                previous_text,
                text,
            } => {
                check(&revision)?;
                if text.trim().is_empty() || text.len() > 16 * 1024 {
                    return Err("MARKDOWN_ANCHOR_INVALID");
                }
                let mut data: Comments = self.sidecar(id, "comments.json")?;
                let comment = data
                    .comments
                    .iter_mut()
                    .find(|v| {
                        v.id == comment_id
                            && v.kind == kind
                            && v.status == MarkdownCommentStatus::Open
                    })
                    .ok_or("MARKDOWN_ANCHOR_INVALID")?;
                if comment.text != previous_text {
                    return Err("MARKDOWN_CONFLICT");
                }
                comment.text = text;
                self.write_sidecar(id, "comments.json", &data)?;
            }
            MarkdownAnnotationAction::Resolve { id: comment_id } => {
                let mut data: Comments = self.sidecar(id, "comments.json")?;
                let comment = data
                    .comments
                    .iter_mut()
                    .find(|v| v.id == comment_id && v.kind == kind)
                    .ok_or("MARKDOWN_ANCHOR_INVALID")?;
                comment.status = MarkdownCommentStatus::Resolved;
                self.write_sidecar(id, "comments.json", &data)?;
            }
            MarkdownAnnotationAction::Reposition {
                id: comment_id,
                revision,
                range,
            } => {
                check(&revision)?;
                let mut data: Comments = self.sidecar(id, "comments.json")?;
                let comment = data
                    .comments
                    .iter_mut()
                    .find(|v| v.id == comment_id && v.kind == kind)
                    .ok_or("MARKDOWN_ANCHOR_INVALID")?;
                comment.anchor = anchor(
                    &doc,
                    &blocks(&doc.text),
                    range.start as usize..range.end as usize,
                    "selection".into(),
                )?;
                self.write_sidecar(id, "comments.json", &data)?;
            }
        }
        self.annotations_inner(id, kind)
    }
    fn scoped_inner(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        revision: &str,
        comment_id: &str,
    ) -> Result<(MarkdownDocument, Range<usize>, String)> {
        let doc = self.read_document_inner(id, kind.clone())?;
        if doc.revision.as_deref() != Some(revision) {
            return Err("MARKDOWN_CONFLICT");
        }
        let data: Comments = self.sidecar(id, "comments.json")?;
        let c = data
            .comments
            .iter()
            .find(|c| {
                c.id == comment_id && c.kind == kind && c.status == MarkdownCommentStatus::Open
            })
            .ok_or("MARKDOWN_ANCHOR_INVALID")?;
        let range = locate(&doc.text, revision, &blocks(&doc.text), &c.anchor, false)
            .ok_or("MARKDOWN_ANCHOR_DETACHED")?;
        let locks = self.annotations_inner(id, kind)?.locks;
        for l in locks {
            for a in l.anchors {
                let start = a.resolved_start.ok_or("MARKDOWN_LOCK_CONFLICT")? as usize;
                let end = a.resolved_end.ok_or("MARKDOWN_LOCK_CONFLICT")? as usize;
                if range.start < end && range.end > start {
                    return Err("MARKDOWN_LOCKED");
                }
            }
        }
        Ok((doc, range, c.text.clone()))
    }
    pub fn scoped_snapshot(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        revision: &str,
        comment_id: &str,
    ) -> Result<(String, String, MarkdownRange, String)> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let (doc, range, instruction) = self.scoped_inner(id, kind, revision, comment_id)?;
        let fingerprint = digest(&doc.text[range.clone()]);
        Ok((
            doc.text[range.clone()].to_string(),
            instruction,
            MarkdownRange {
                start: range.start as i64,
                end: range.end as i64,
            },
            fingerprint,
        ))
    }
    pub fn apply_scoped(
        &self,
        id: &str,
        kind: MarkdownDocumentKind,
        action: MarkdownScopedApply,
    ) -> Result<MarkdownDocument> {
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "MARKDOWN_STORAGE_UNAVAILABLE")?;
        let (doc, range, _) =
            self.scoped_inner(id, kind.clone(), &action.revision, &action.comment_id)?;
        if range.start as i64 != action.range.start
            || range.end as i64 != action.range.end
            || digest(&doc.text[range.clone()]) != action.fingerprint
        {
            return Err("MARKDOWN_CONFLICT");
        }
        if action.text.len() > 256 * 1024 {
            return Err("MARKDOWN_TEXT_INVALID");
        }
        let mut text = doc.text.clone();
        text.replace_range(range, &action.text);
        self.save_document_inner(id, kind, Some(&action.revision), text, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn range(text: &str, quote: &str) -> MarkdownRange {
        let start = text.find(quote).unwrap();
        MarkdownRange {
            start: start as i64,
            end: (start + quote.len()) as i64,
        }
    }
    fn lock(
        store: &MarkdownProjects,
        doc: &MarkdownDocument,
        quotes: &[&str],
    ) -> MarkdownAnnotations {
        store
            .annotate(
                &doc.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Lock {
                    revision: doc.revision.clone().unwrap(),
                    ranges: quotes.iter().map(|quote| range(&doc.text, quote)).collect(),
                },
            )
            .unwrap()
    }
    #[test]
    fn mor_ac04_shared_exact_protection_moves_ambiguity_and_corrupt_sidecars() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store
            .create("# Manuscript\n\nProtected 中文 paragraph\n\nEditable".into())
            .unwrap();
        let manuscript = store
            .read_document(&p.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        lock(&store, &manuscript, &["Protected 中文 paragraph"]);
        assert_eq!(
            store
                .save(
                    &p.project_id,
                    &p.revision,
                    p.text.replace("Protected", "Changed")
                )
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        let outline = store.save_document(&p.project_id, MarkdownDocumentKind::Outline, None, "\u{feff}# First\r\n\r\n* locked **中文**\r\n* editable\r\n\r\n# Second\r\n\r\nTail".into()).unwrap();
        lock(&store, &outline, &["# First", "* locked **中文**"]);
        let adjacent = store
            .save_document(
                &p.project_id,
                outline.kind.clone(),
                outline.revision.as_deref(),
                outline.text.replace("editable", "changed neighbor"),
            )
            .unwrap();
        assert!(adjacent.text.contains("* locked **中文**\r\n"));
        for text in [adjacent.text.replace("* locked **中文**\r\n", ""), adjacent.text.replace("* locked **中文**", "* changed"), "\u{feff}# First\r\n\r\n* changed neighbor\r\n\r\n# Second\r\n\r\n* locked **中文**\r\n\r\nTail".into()] {
            assert_eq!(store.save_document(&p.project_id, adjacent.kind.clone(), adjacent.revision.as_deref(), text).unwrap_err(), "MARKDOWN_LOCKED");
        }
        let reopened = MarkdownProjects::open(root.path()).unwrap();
        assert_eq!(
            reopened
                .annotations(&p.project_id, MarkdownDocumentKind::Outline)
                .unwrap()
                .locks[0]
                .anchors
                .len(),
            2
        );
        assert_eq!(
            reopened
                .annotations(&p.project_id, MarkdownDocumentKind::Manuscript)
                .unwrap()
                .locks
                .len(),
            1
        );
        let repeated = store
            .create("A\n\n- same\n\nMiddle\n\n- same\n\nTail".into())
            .unwrap();
        let repeated_doc = store
            .read_document(&repeated.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        lock(&store, &repeated_doc, &["- same"]);
        store
            .save(
                &repeated.project_id,
                &repeated.revision,
                repeated.text.replace("Tail", "New tail"),
            )
            .unwrap();
        let dup = store.create("- same\n- same\n\nOther".into()).unwrap();
        let doc = store
            .read_document(&dup.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        let state = lock(&store, &doc, &["- same"]);
        assert_eq!(
            store
                .save(
                    &dup.project_id,
                    &dup.revision,
                    dup.text.replace("Other", "New")
                )
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        // An external edit makes the old match ambiguous; the lock remains explicitly unlockable.
        std::fs::write(
            root.path().join(&dup.project_id).join("manuscript.md"),
            dup.text.replace("Other", "External"),
        )
        .unwrap();
        let live = store.read(&dup.project_id).unwrap();
        assert_eq!(
            store
                .annotations(&dup.project_id, MarkdownDocumentKind::Manuscript)
                .unwrap()
                .locks[0]
                .anchors[0]
                .resolved_start,
            None
        );
        assert_eq!(
            store
                .save(&dup.project_id, &live.revision, "anything".into())
                .unwrap_err(),
            "MARKDOWN_LOCK_CONFLICT"
        );
        store
            .annotate(
                &dup.project_id,
                MarkdownDocumentKind::Manuscript,
                MarkdownAnnotationAction::Unlock {
                    id: state.locks[0].id.clone(),
                },
            )
            .unwrap();
        store
            .save(&dup.project_id, &live.revision, "unlocked".into())
            .unwrap();
        std::fs::write(
            root.path().join(&p.project_id).join("locks.json"),
            b"broken",
        )
        .unwrap();
        assert_eq!(
            store
                .save(&p.project_id, &p.revision, p.text.clone())
                .unwrap_err(),
            "MARKDOWN_ANNOTATIONS_UNAVAILABLE"
        );
    }
    #[test]
    fn mor_ac04_parent_rename_and_individual_list_location() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store
            .create("# First\n\n- locked\n- editable\n\n# Second\n\nEnd".into())
            .unwrap();
        let doc = store
            .read_document(&p.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        lock(&store, &doc, &["- locked"]);
        let saved = store
            .save(
                &p.project_id,
                &p.revision,
                p.text
                    .replace("First", "Renamed")
                    .replace("editable", "new sibling"),
            )
            .unwrap();
        assert!(
            store
                .annotations(&p.project_id, doc.kind.clone())
                .unwrap()
                .locks[0]
                .anchors[0]
                .resolved_start
                .is_some()
        );
        assert_eq!(
            store
                .save(
                    &p.project_id,
                    &saved.revision,
                    "# Renamed\n\n- new sibling\n\n# Second\n\n- locked\n\nEnd".into()
                )
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        let p = store.create("Protected".into()).unwrap();
        let doc = store
            .read_document(&p.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        lock(&store, &doc, &["Protected"]);
        let saved = store
            .save(
                &p.project_id,
                &p.revision,
                "New neighbor\n\nProtected".into(),
            )
            .unwrap();
        assert_eq!(
            store
                .save(
                    &p.project_id,
                    &saved.revision,
                    "Protected\n\nNew neighbor".into()
                )
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        // A protected nested bullet cannot be moved to a different parent item.
        let nested = store
            .create("- Parent one\n  - child\n- Parent two\n  - other".into())
            .unwrap();
        let doc = store
            .read_document(&nested.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        lock(&store, &doc, &["- child"]);
        assert_eq!(
            store
                .save(
                    &nested.project_id,
                    &nested.revision,
                    "- Parent one\n  - other\n- Parent two\n  - child".into()
                )
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
    }
    #[test]
    fn awr_ac02_comment_edits_preserve_identity_and_reject_stale_input() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store.create("A passage 中文".into()).unwrap();
        let kind = MarkdownDocumentKind::Manuscript;
        let data = store
            .annotate(
                &p.project_id,
                kind.clone(),
                MarkdownAnnotationAction::Comment {
                    revision: p.revision.clone(),
                    range: range(&p.text, "passage"),
                    text: "Original note".into(),
                },
            )
            .unwrap();
        let original = &data.comments[0];
        let edit = |revision: &str, previous: &str, text: &str| MarkdownAnnotationAction::Edit {
            id: original.id.clone(),
            revision: revision.into(),
            previous_text: previous.into(),
            text: text.into(),
        };
        assert_eq!(
            store
                .annotate(
                    &p.project_id,
                    kind.clone(),
                    edit("stale", "Original note", "Changed")
                )
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        assert_eq!(
            store
                .annotate(
                    &p.project_id,
                    kind.clone(),
                    edit(&p.revision, "newer", "Changed")
                )
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        assert_eq!(
            store
                .annotate(
                    &p.project_id,
                    kind.clone(),
                    edit(&p.revision, "Original note", " ")
                )
                .unwrap_err(),
            "MARKDOWN_ANCHOR_INVALID"
        );
        let edited = store
            .annotate(
                &p.project_id,
                kind.clone(),
                edit(&p.revision, "Original note", "补充具体细节"),
            )
            .unwrap();
        assert_eq!(edited.comments[0].id, original.id);
        assert_eq!(edited.comments[0].anchor.quote, original.anchor.quote);
        assert_eq!(edited.comments[0].text, "补充具体细节");
        assert_eq!(store.read(&p.project_id).unwrap().text, p.text);
        assert_eq!(
            store
                .annotate(
                    &p.project_id,
                    kind.clone(),
                    edit(&p.revision, "Original note", "Late edit")
                )
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        store
            .annotate(
                &p.project_id,
                kind.clone(),
                MarkdownAnnotationAction::Resolve {
                    id: original.id.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            store
                .annotate(
                    &p.project_id,
                    kind,
                    edit(&p.revision, "补充具体细节", "Resolved edit")
                )
                .unwrap_err(),
            "MARKDOWN_ANCHOR_INVALID"
        );
    }
    #[test]
    fn mor_ac05_detached_comments_keep_quote_status_and_utf8_evidence() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store.create("Manuscript".into()).unwrap();
        let doc = store
            .save_document(
                &p.project_id,
                MarkdownDocumentKind::Outline,
                None,
                "# 中文\n\n- one\n- two\n\nTail".into(),
            )
            .unwrap();
        let quote = "# 中文\n\n- one\n- two";
        let state = store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Comment {
                    revision: doc.revision.clone().unwrap(),
                    range: range(&doc.text, quote),
                    text: "Revise this span".into(),
                },
            )
            .unwrap();
        let c = &state.comments[0];
        assert_eq!(c.anchor.end, quote.len() as i64);
        let next = store
            .save_document(
                &p.project_id,
                doc.kind.clone(),
                doc.revision.as_deref(),
                doc.text.replace("Tail", "Changed unrelated"),
            )
            .unwrap();
        assert_eq!(
            store
                .annotations(&p.project_id, doc.kind.clone())
                .unwrap()
                .comments[0]
                .anchor
                .resolved_start,
            Some(0)
        );
        let detached = store
            .save_document(
                &p.project_id,
                doc.kind.clone(),
                next.revision.as_deref(),
                "Only unrelated text remains".into(),
            )
            .unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let current = store.annotations(&p.project_id, doc.kind.clone()).unwrap();
        assert_eq!(current.comments[0].anchor.resolved_start, None);
        assert_eq!(current.comments[0].anchor.quote, quote);
        assert_eq!(current.comments[0].text, c.text);
        let resolved = store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Resolve { id: c.id.clone() },
            )
            .unwrap();
        assert_eq!(resolved.comments[0].status, MarkdownCommentStatus::Resolved);
        assert_eq!(
            store.read_document(&p.project_id, doc.kind).unwrap(),
            detached
        );
    }
    #[test]
    fn mor_ac06_live_locks_stale_revisions_and_repositioned_comment_reject_adoption() {
        let root = tempfile::tempdir().unwrap();
        let store = MarkdownProjects::open(root.path()).unwrap();
        let p = store
            .create("Before\n\nTarget 中文\n\nAfter".into())
            .unwrap();
        let doc = store
            .read_document(&p.project_id, MarkdownDocumentKind::Manuscript)
            .unwrap();
        let state = store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Comment {
                    revision: p.revision.clone(),
                    range: range(&p.text, "Target 中文"),
                    text: "Improve".into(),
                },
            )
            .unwrap();
        let c = &state.comments[0];
        let (_, _, scope, fingerprint) = store
            .scoped_snapshot(&p.project_id, doc.kind.clone(), &p.revision, &c.id)
            .unwrap();
        let action = MarkdownScopedApply {
            revision: p.revision.clone(),
            comment_id: c.id.clone(),
            text: "Replacement".into(),
            range: scope,
            fingerprint,
        };
        let locked = lock(&store, &doc, &["Target 中文"]);
        assert_eq!(
            store
                .apply_scoped(&p.project_id, doc.kind.clone(), action.clone())
                .unwrap_err(),
            "MARKDOWN_LOCKED"
        );
        assert_eq!(store.read(&p.project_id).unwrap(), p);
        store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Unlock {
                    id: locked.locks[0].id.clone(),
                },
            )
            .unwrap();
        store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Reposition {
                    id: c.id.clone(),
                    revision: p.revision.clone(),
                    range: range(&p.text, "After"),
                },
            )
            .unwrap();
        assert_eq!(
            store
                .apply_scoped(&p.project_id, doc.kind.clone(), action.clone())
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        store
            .annotate(
                &p.project_id,
                doc.kind.clone(),
                MarkdownAnnotationAction::Reposition {
                    id: c.id.clone(),
                    revision: p.revision.clone(),
                    range: range(&p.text, "Target 中文"),
                },
            )
            .unwrap();
        let applied = store
            .apply_scoped(&p.project_id, doc.kind.clone(), action.clone())
            .unwrap();
        assert_eq!(applied.text, "Before\n\nReplacement\n\nAfter");
        assert_eq!(
            store
                .apply_scoped(&p.project_id, doc.kind.clone(), action)
                .unwrap_err(),
            "MARKDOWN_CONFLICT"
        );
        // A broken comments sidecar cannot cause a successful lock write followed by an error response.
        std::fs::write(
            root.path().join(&p.project_id).join("comments.json"),
            b"broken",
        )
        .unwrap();
        let result = store.annotate(
            &p.project_id,
            doc.kind,
            MarkdownAnnotationAction::Lock {
                revision: applied.revision.unwrap(),
                ranges: vec![range(&applied.text, "Before")],
            },
        );
        assert_eq!(result.unwrap_err(), "MARKDOWN_ANNOTATIONS_UNAVAILABLE");
        let locks: Locks = store.sidecar(&p.project_id, "locks.json").unwrap();
        assert!(locks.locks.is_empty());
    }
}
