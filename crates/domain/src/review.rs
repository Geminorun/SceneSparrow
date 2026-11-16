//! Script-owned review scope and closed output interpretation.
use crate::{
    contracts::*,
    manuscript::{self, ManuscriptError},
    planning::ensure,
};
use std::collections::BTreeSet;
use unicode_segmentation::UnicodeSegmentation;
pub type Result<T> = std::result::Result<T, ManuscriptError>;
pub fn text(b: &Block) -> String {
    b.runs.iter().map(|r| r.text.as_str()).collect()
}
pub fn byte_at(s: &str, offset: i64) -> Result<usize> {
    ensure(offset >= 0, "ANCHOR_INVALID")?;
    let mut n = 0;
    for (i, g) in s.grapheme_indices(true) {
        if n == offset {
            return Ok(i);
        }
        n += g.encode_utf16().count() as i64;
    }
    ensure(n == offset, "ANCHOR_INVALID")?;
    Ok(s.len())
}
pub fn validate_anchor(state: &ManuscriptState, anchor: &ReviewAnchor) -> Result<()> {
    ensure(
        !anchor.ranges.is_empty() && anchor.ranges.len() <= 100 && anchor.state == "mapped",
        "ANCHOR_INVALID",
    )?;
    let mut prior = None;
    for (range_index, r) in anchor.ranges.iter().enumerate() {
        let pos = state
            .blocks
            .iter()
            .position(|b| b.id == r.block_id)
            .ok_or(ManuscriptError("ANCHOR_STALE", None))?;
        ensure(prior.is_none_or(|p| p + 1 == pos), "ANCHOR_INVALID")?;
        prior = Some(pos);
        let b = &state.blocks[pos];
        let t = text(b);
        ensure(r.revision == b.revision, "ANCHOR_STALE")?;
        let (start, end) = (byte_at(&t, r.start)?, byte_at(&t, r.end)?);
        ensure(start <= end && t[start..end] == r.quote, "ANCHOR_STALE")?;
        ensure(
            (range_index == 0 || start == 0)
                && (range_index + 1 == anchor.ranges.len() || end == t.len()),
            "ANCHOR_INVALID",
        )?;
        ensure(
            !r.whole_block || (start == 0 && end == t.len()),
            "ANCHOR_INVALID",
        )?;
    }
    if let Some(slot) = &anchor.slot {
        validate_slot(state, slot)?;
        ensure(
            anchor.ranges.len() == 1 && anchor.ranges[0].block_id == slot.heading_id,
            "ANCHOR_INVALID",
        )?;
    }
    Ok(())
}
pub fn validate_slot(state: &ManuscriptState, slot: &ReviewSlot) -> Result<usize> {
    let i = state
        .blocks
        .iter()
        .position(|b| b.id == slot.heading_id)
        .ok_or(ManuscriptError("CANDIDATE_STALE", None))?;
    let h = &state.blocks[i];
    ensure(
        h.kind == BlockKind::Heading && slot.before_id == h.id,
        "PATCH_OUT_OF_SCOPE",
    )?;
    let next = state.blocks.get(i + 1);
    ensure(
        next.map(|b| b.id.clone()) == slot.after_id
            && next.is_none_or(|b| b.kind == BlockKind::Heading && b.attrs.level <= h.attrs.level),
        "CANDIDATE_STALE",
    )?;
    Ok(i + 1)
}
pub fn validate_thread(t: &ReviewThread) -> Result<()> {
    ensure(
        manuscript::uuid4(&t.id)
            && !t.text.trim().is_empty()
            && t.text.len() <= 16384
            && !t
                .text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t'),
        "INVALID_REQUEST",
    )?;
    ensure(
        t.kind != ReviewThreadKind::Question || t.anchor.slot.is_none(),
        "ANCHOR_INVALID",
    )?;
    let mut p = crate::planning::empty();
    p.brief.language = t.language.clone();
    p.evidence = t.evidence.clone();
    crate::planning::validate(&p, false)
}
pub fn snapshot(threads: &[ReviewThread]) -> Vec<ReviewThread> {
    threads
        .iter()
        .filter(|t| !t.deleted)
        .map(|t| {
            let mut t = t.clone();
            t.request_version = 0;
            for r in &mut t.anchor.ranges {
                r.revision = 0;
                if r.quote_hash.is_some() {
                    r.quote.clear();
                }
            }
            t
        })
        .collect()
}
/// Full-run S1 edits provide no character operation identity. Only a proven unique
/// single splice outside the selection is mapped. Ambiguous repeated text and
/// multiple changed spans conservatively retain the quote as source_changed.
pub fn map_anchor(
    before: &ManuscriptState,
    after: &ManuscriptState,
    a: &ReviewAnchor,
) -> ReviewAnchor {
    let mut a = a.clone();
    if a.state != "mapped" {
        if a.ranges
            .iter()
            .any(|r| !after.blocks.iter().any(|b| b.id == r.block_id))
        {
            a.state = "orphaned".into();
        }
        return a;
    }
    for r in &mut a.ranges {
        let old = before.blocks.iter().find(|b| b.id == r.block_id);
        let new = after.blocks.iter().find(|b| b.id == r.block_id);
        match (old, new) {
            (Some(old), Some(new)) => {
                let x = text(old);
                let y = text(new);
                r.revision = new.revision;
                if x == y {
                    continue;
                }
                if r.whole_block {
                    a.state = "source_changed".into();
                    continue;
                }
                // S1 split identity: first retains its ID; only its new adjacent
                // sibling can receive the exact suffix. Never search by quote.
                if let Some(i) = after.blocks.iter().position(|b| b.id == old.id)
                    && let Some(sibling) = after.blocks.get(i + 1)
                    && !before.blocks.iter().any(|b| b.id == sibling.id)
                    && format!("{}{}", y, text(sibling)) == x
                {
                    let cut = y.encode_utf16().count() as i64;
                    if r.start >= cut {
                        r.block_id = sibling.id.clone();
                        r.revision = sibling.revision;
                        r.start -= cut;
                        r.end -= cut;
                        continue;
                    }
                    if r.end <= cut {
                        continue;
                    }
                    a.state = "source_changed".into();
                    continue;
                }
                let xg = x.graphemes(true).collect::<Vec<_>>();
                let yg = y.graphemes(true).collect::<Vec<_>>();
                let p = xg.iter().zip(&yg).take_while(|(x, y)| x == y).count();
                let s = xg
                    .iter()
                    .rev()
                    .zip(yg.iter().rev())
                    .take_while(|(x, y)| x == y)
                    .count();
                if p + s > xg.len().min(yg.len()) {
                    a.state = "source_changed".into();
                    continue;
                }
                let start = xg[..p].concat().encode_utf16().count() as i64;
                let end = xg[..xg.len() - s].concat().encode_utf16().count() as i64;
                let delta = y.encode_utf16().count() as i64 - x.encode_utf16().count() as i64;
                if end <= r.start {
                    r.start += delta;
                    r.end += delta;
                } else if start < r.end {
                    a.state = "source_changed".into();
                }
            }
            (Some(old), None) => {
                let i = before.blocks.iter().position(|b| b.id == old.id).unwrap();
                let merged = if i > 0 {
                    let prev = &before.blocks[i - 1];
                    after
                        .blocks
                        .iter()
                        .find(|b| b.id == prev.id)
                        .filter(|b| text(b) == format!("{}{}", text(prev), text(old)))
                        .map(|b| (b, text(prev).encode_utf16().count() as i64))
                } else {
                    None
                };
                if let Some((b, offset)) = merged {
                    r.block_id = b.id.clone();
                    r.revision = b.revision;
                    r.start += offset;
                    r.end += offset;
                    r.whole_block = false;
                } else {
                    a.state = "orphaned".into();
                }
            }
            _ => a.state = "orphaned".into(),
        }
    }
    if let Some(slot) = &a.slot
        && validate_slot(after, slot).is_err()
    {
        a.state = "source_changed".into();
    }
    let mut check = a.clone();
    for r in &mut check.ranges {
        if r.quote_hash.is_some()
            && r.quote.is_empty()
            && let Some(block) = after.blocks.iter().find(|b| b.id == r.block_id)
        {
            let t = text(block);
            if let (Ok(start), Ok(end)) = (byte_at(&t, r.start), byte_at(&t, r.end))
                && start <= end
            {
                r.quote = t[start..end].into();
            }
        }
    }
    if a.state == "mapped" && validate_anchor(after, &check).is_err() {
        a.state = "source_changed".into();
    }
    a
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Answer {
    schema_version: i64,
    answer: String,
    evidence_references: Vec<String>,
}
pub fn answer(bytes: &[u8], evidence: &[PlanningEvidence]) -> Result<String> {
    let a: Answer =
        serde_json::from_slice(bytes).map_err(|_| ManuscriptError("INVALID_OUTPUT", None))?;
    ensure(
        a.schema_version == 1
            && !a.answer.trim().is_empty()
            && a.answer.len() <= 16384
            && a.evidence_references.len() <= 100
            && a.evidence_references
                .iter()
                .all(|id| evidence.iter().any(|e| &e.id == id)),
        "INVALID_OUTPUT",
    )?;
    Ok(a.answer)
}
#[derive(serde::Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Proposal {
    ReplaceRanges {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
        replacements: Vec<Replacement>,
        explanation: String,
    },
    FillSection {
        #[serde(rename = "schemaVersion")]
        schema_version: i64,
        blocks: Vec<crate::planning::DraftBlock>,
        explanation: String,
    },
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replacement {
    range_index: usize,
    runs: Vec<TextRun>,
}
/// Materialize against the captured canonical base. Output never supplies IDs,
/// structure, arbitrary commands or decisions for existing content.
pub fn proposal(bytes: &[u8], base: &ManuscriptState, anchor: &ReviewAnchor) -> Result<Vec<Block>> {
    ensure(bytes.len() <= 4 * 1024 * 1024, "INPUT_TOO_LARGE")?;
    validate_anchor(base, anchor)?;
    let p: Proposal =
        serde_json::from_slice(bytes).map_err(|_| ManuscriptError("INVALID_OUTPUT", None))?;
    let mut result = base.clone();
    match p {
        Proposal::ReplaceRanges {
            schema_version,
            replacements,
            explanation,
        } => {
            ensure(
                !explanation.trim().is_empty() && explanation.len() <= 2048,
                "INVALID_OUTPUT",
            )?;
            ensure(
                schema_version == 1
                    && anchor.slot.is_none()
                    && replacements.len() == anchor.ranges.len(),
                "PATCH_OUT_OF_SCOPE",
            )?;
            let mut seen = BTreeSet::new();
            for replacement in replacements {
                let r = anchor
                    .ranges
                    .get(replacement.range_index)
                    .ok_or(ManuscriptError("PATCH_OUT_OF_SCOPE", None))?;
                ensure(seen.insert(replacement.range_index), "PATCH_OUT_OF_SCOPE")?;
                let b = result
                    .blocks
                    .iter_mut()
                    .find(|b| b.id == r.block_id)
                    .ok_or(ManuscriptError("CANDIDATE_STALE", None))?;
                let mut runs = slice_runs(&b.runs, 0, r.start)?;
                runs.extend(replacement.runs);
                runs.extend(slice_runs(
                    &b.runs,
                    r.end,
                    text(b).encode_utf16().count() as i64,
                )?);
                b.runs = runs;
            }
        }
        Proposal::FillSection {
            schema_version,
            blocks,
            explanation,
        } => {
            ensure(
                !explanation.trim().is_empty() && explanation.len() <= 2048,
                "INVALID_OUTPUT",
            )?;
            ensure(
                schema_version == 1 && !blocks.is_empty() && blocks.len() <= 100,
                "PATCH_OUT_OF_SCOPE",
            )?;
            let slot = anchor
                .slot
                .as_ref()
                .ok_or(ManuscriptError("PATCH_OUT_OF_SCOPE", None))?;
            let pos = validate_slot(base, slot)?;
            let mut added = vec![];
            for b in blocks {
                ensure(b.kind != BlockKind::Heading, "PATCH_OUT_OF_SCOPE")?;
                added.push(Block {
                    id: uuid::Uuid::new_v4().to_string(),
                    revision: 1,
                    kind: b.kind,
                    attrs: b.attrs,
                    runs: b.runs,
                });
            }
            result.blocks.splice(pos..pos, added);
        }
    }
    if anchor.slot.is_none() {
        // A scoped nested list is not a standalone document. Validate run/mark
        // payloads with neutral list depths, retaining the captured structure.
        // Acceptance reconstructs and normalizes the entire current document.
        let mut check = result.clone();
        for block in &mut check.blocks {
            if block.kind == BlockKind::Listitem {
                block.attrs.depth = Some(0);
            }
        }
        manuscript::normalize(&mut check)?;
        for (block, normalized) in result.blocks.iter_mut().zip(check.blocks) {
            block.runs = normalized.runs;
        }
    } else {
        manuscript::normalize(&mut result)?;
    }
    Ok(result.blocks)
}
fn scalar_byte_at(s: &str, offset: i64) -> Result<usize> {
    let mut n = 0;
    for (i, ch) in s.char_indices() {
        if n == offset {
            return Ok(i);
        }
        n += ch.len_utf16() as i64;
    }
    ensure(n == offset, "ANCHOR_INVALID")?;
    Ok(s.len())
}
fn slice_runs(runs: &[TextRun], start: i64, end: i64) -> Result<Vec<TextRun>> {
    let mut out = vec![];
    let mut offset = 0;
    for r in runs {
        let len = r.text.encode_utf16().count() as i64;
        let lo = start.max(offset);
        let hi = end.min(offset + len);
        if lo < hi {
            let mut run = r.clone();
            run.text = r.text
                [scalar_byte_at(&r.text, lo - offset)?..scalar_byte_at(&r.text, hi - offset)?]
                .into();
            out.push(run);
        }
        offset += len;
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn block(value: &str) -> Block {
        Block {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            kind: BlockKind::Paragraph,
            attrs: BlockAttrs {
                level: None,
                list_kind: None,
                depth: None,
            },
            runs: vec![TextRun {
                text: value.into(),
                marks: vec![],
            }],
        }
    }
    fn state(blocks: Vec<Block>) -> ManuscriptState {
        ManuscriptState {
            manuscript_id: uuid::Uuid::new_v4().to_string(),
            working_revision: 1,
            workspace_stage: ManuscriptStateWorkspaceStage::Draft,
            schema_version: 1,
            blocks,
        }
    }
    fn anchor(b: &Block, start: i64, end: i64) -> ReviewAnchor {
        let t = text(b);
        ReviewAnchor {
            ranges: vec![ReviewRange {
                block_id: b.id.clone(),
                revision: b.revision,
                start,
                end,
                quote: t[byte_at(&t, start).unwrap()..byte_at(&t, end).unwrap()].into(),
                whole_block: false,
                quote_hash: None,
            }],
            state: "mapped".into(),
            slot: None,
        }
    }
    #[test]
    fn unicode_cross_block_boundaries_and_exact_quote_are_authoritative() {
        let a = block("中🐦é文");
        let b = block("next");
        let state = state(vec![a.clone(), b.clone()]);
        let mut anchor = anchor(&a, 1, 6);
        anchor
            .ranges
            .push(super::tests::anchor(&b, 0, 2).ranges.remove(0));
        assert!(
            validate_anchor(&state, &anchor).is_ok(),
            "{:?} {:?} {:?}",
            validate_anchor(&state, &anchor),
            state,
            anchor
        );
        for n in [2, 4] {
            assert_eq!(byte_at("中🐦é文", n).unwrap_err().0, "ANCHOR_INVALID");
        }
        anchor.ranges[0].quote = "other".into();
        assert_eq!(
            validate_anchor(&state, &anchor).unwrap_err().0,
            "ANCHOR_STALE"
        );
    }
    #[test]
    fn mapping_is_identity_based_conservative_on_repeats_and_multiple_spans() {
        let b = block("left SELECT right");
        let before = state(vec![b.clone()]);
        let a = anchor(&b, 5, 11);
        let mut after = before.clone();
        after.blocks[0].runs[0].text = "++left SELECT right".into();
        after.blocks[0].revision = 2;
        let mapped = map_anchor(&before, &after, &a);
        assert_eq!(mapped.state, "mapped");
        assert_eq!(mapped.ranges[0].start, 7);
        assert_eq!(mapped.ranges[0].quote, "SELECT");
        after.blocks[0].runs[0].text = "LEFT SELECT RIGHT".into();
        assert_eq!(map_anchor(&before, &after, &a).state, "source_changed");
        let r = block("same same");
        let before = state(vec![r.clone()]);
        let a = anchor(&r, 5, 9);
        let mut after = before.clone();
        after.blocks[0].runs[0].text = "same".into();
        assert_eq!(map_anchor(&before, &after, &a).state, "source_changed");
        after.blocks.clear();
        assert_eq!(map_anchor(&before, &after, &a).state, "orphaned");
    }
    #[test]
    fn exact_adjacent_split_merge_move_and_marks_preserve_proven_identity() {
        let b = block("left right");
        let before = state(vec![b.clone()]);
        let a = anchor(&b, 5, 10);
        let mut after = before.clone();
        after.blocks[0].runs[0].text = "left ".into();
        let sibling = block("right");
        after.blocks.push(sibling.clone());
        let mapped = map_anchor(&before, &after, &a);
        assert_eq!(mapped.state, "mapped");
        assert_eq!(mapped.ranges[0].block_id, sibling.id);
        assert_eq!(mapped.ranges[0].start, 0);
        let merged = map_anchor(&after, &before, &mapped);
        assert_eq!(merged.state, "mapped");
        assert_eq!(merged.ranges[0].block_id, b.id);
        assert_eq!(merged.ranges[0].start, 5);
        after = before.clone();
        after.blocks[0].runs[0].marks.push(Mark {
            r#type: MarkType::Bold,
            href: None,
        });
        assert_eq!(map_anchor(&before, &after, &a).state, "mapped");
    }
    #[test]
    fn materialization_keeps_outside_text_marks_ids_and_closed_modes() {
        let mut b = block("A🐦B");
        b.runs[0].marks = vec![Mark {
            r#type: MarkType::Bold,
            href: None,
        }];
        let base = state(vec![b.clone()]);
        let a = anchor(&b, 1, 3);
        let value = serde_json::json!({"schemaVersion":1,"explanation":"Scoped wording improvement","mode":"replace_ranges","replacements":[{"rangeIndex":0,"runs":[{"text":"中","marks":[]}]}]});
        let result = proposal(&serde_json::to_vec(&value).unwrap(), &base, &a).unwrap();
        assert_eq!(text(&result[0]), "A中B");
        assert_eq!(result[0].id, b.id);
        assert_eq!(result[0].runs[0].marks, b.runs[0].marks);
        assert_eq!(result[0].runs[2].marks, b.runs[0].marks);
        let mut bad = value;
        bad["replacements"][0]["id"] = serde_json::json!(b.id);
        assert_eq!(
            proposal(&serde_json::to_vec(&bad).unwrap(), &base, &a)
                .unwrap_err()
                .0,
            "INVALID_OUTPUT"
        );
    }
}
#[cfg(test)]
mod marked_grapheme_tests {
    use super::*;
    #[test]
    fn global_graphemes_may_cross_mark_run_boundaries() {
        for (runs, start, end, wanted) in [
            (vec!["🇺", "🇸🇨"], 0, 4, "X🇨"),
            (vec!["👩", "‍💻z"], 0, 5, "Xz"),
            (vec!["e", "́z"], 0, 2, "Xz"),
        ] {
            let block = Block {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                kind: BlockKind::Paragraph,
                attrs: BlockAttrs {
                    level: None,
                    depth: None,
                    list_kind: None,
                },
                runs: runs
                    .iter()
                    .enumerate()
                    .map(|(i, s)| TextRun {
                        text: (*s).into(),
                        marks: if i == 0 {
                            vec![Mark {
                                r#type: MarkType::Bold,
                                href: None,
                            }]
                        } else {
                            vec![]
                        },
                    })
                    .collect(),
            };
            let base = ManuscriptState {
                manuscript_id: uuid::Uuid::new_v4().to_string(),
                schema_version: 1,
                working_revision: 1,
                workspace_stage: ManuscriptStateWorkspaceStage::Draft,
                blocks: vec![block.clone()],
            };
            let t = text(&block);
            let a = ReviewAnchor {
                ranges: vec![ReviewRange {
                    block_id: block.id.clone(),
                    revision: 1,
                    start,
                    end,
                    quote: t[byte_at(&t, start).unwrap()..byte_at(&t, end).unwrap()].into(),
                    whole_block: false,
                    quote_hash: None,
                }],
                state: "mapped".into(),
                slot: None,
            };
            let bytes=serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"explanation":"Scoped wording improvement","mode":"replace_ranges","replacements":[{"rangeIndex":0,"runs":[{"text":"X","marks":[]}]}]})).unwrap();
            let result = proposal(&bytes, &base, &a).unwrap();
            assert_eq!(text(&result[0]), wanted);
        }
    }
}

pub fn explanation(bytes: &[u8]) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ManuscriptError("INVALID_OUTPUT", None))?;
    value
        .get("explanation")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty() && s.len() <= 2048)
        .map(str::to_owned)
        .ok_or(ManuscriptError("INVALID_OUTPUT", None))
}
#[cfg(test)]
mod mapped_projection_tests {
    use super::*;
    #[test]
    fn cross_block_merge_and_reorder_never_leave_invalid_mapped_ranges() {
        let make = |value: &str| Block {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            kind: BlockKind::Paragraph,
            attrs: BlockAttrs {
                depth: None,
                level: None,
                list_kind: None,
            },
            runs: vec![TextRun {
                text: value.into(),
                marks: vec![],
            }],
        };
        let a = make("left ");
        let b = make("right");
        let before = ManuscriptState {
            manuscript_id: uuid::Uuid::new_v4().to_string(),
            working_revision: 1,
            schema_version: 1,
            workspace_stage: ManuscriptStateWorkspaceStage::Draft,
            blocks: vec![a.clone(), b.clone()],
        };
        let anchor = ReviewAnchor {
            state: "mapped".into(),
            slot: None,
            ranges: before
                .blocks
                .iter()
                .map(|b| ReviewRange {
                    block_id: b.id.clone(),
                    revision: 1,
                    start: 0,
                    end: text(b).encode_utf16().count() as i64,
                    quote: text(b),
                    whole_block: false,
                    quote_hash: None,
                })
                .collect(),
        };
        let mut after = before.clone();
        after.blocks[0].runs[0].text = "left right".into();
        after.blocks.pop();
        assert_eq!(map_anchor(&before, &after, &anchor).state, "source_changed");
        after = before.clone();
        after.blocks.reverse();
        assert_eq!(map_anchor(&before, &after, &anchor).state, "source_changed");
    }
}
