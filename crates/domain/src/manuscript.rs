use crate::contracts::*;
use std::collections::{BTreeMap, BTreeSet};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_REVISION: i64 = 9_007_199_254_740_991;
pub const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BLOCK_BYTES: usize = 1024 * 1024;
pub const MAX_BLOCKS: usize = 10_000;
pub const MAX_OPERATIONS: usize = 10_000;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ManuscriptError(pub &'static str, pub Option<HistoryErrorDetails>);
impl ManuscriptError {
    pub fn history_blocked(reason: &str, affected: &BTreeSet<String>) -> Self {
        Self(
            "HISTORY_BLOCKED",
            Some(HistoryErrorDetails {
                reason: reason.to_owned(),
                candidate_conflicts: None,
                affected_ids: affected.iter().cloned().collect(),
            }),
        )
    }
}
type Result<T> = std::result::Result<T, ManuscriptError>;
fn invalid<T>() -> Result<T> {
    Err(ManuscriptError("DOCUMENT_INVALID", None))
}
pub fn uuid4(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|v| {
        v.get_version_num() == 4 && v.get_variant() == uuid::Variant::RFC4122 && v.to_string() == id
    })
}
pub fn next_revision(v: i64) -> Result<i64> {
    if !(0..MAX_REVISION).contains(&v) {
        return Err(ManuscriptError("REVISION_EXHAUSTED", None));
    }
    Ok(v + 1)
}

pub fn normalize(state: &mut ManuscriptState) -> Result<bool> {
    let before = state.clone();
    if !uuid4(&state.manuscript_id)
        || state.schema_version != 1
        || state.working_revision < 0
        || state.working_revision > MAX_REVISION
    {
        return invalid();
    }
    if state.blocks.len() > MAX_BLOCKS {
        return Err(ManuscriptError("DOCUMENT_TOO_LARGE", None));
    }
    if state.workspace_stage == ManuscriptStateWorkspaceStage::Outline && !state.blocks.is_empty() {
        return invalid();
    }
    let mut ids = BTreeSet::new();
    let mut total = 0;
    let mut previous_depth: Option<i64> = None;
    for block in &mut state.blocks {
        if !uuid4(&block.id)
            || !ids.insert(&block.id)
            || !(1..=MAX_REVISION).contains(&block.revision)
        {
            return invalid();
        }
        match block.kind {
            BlockKind::Paragraph => {
                if block.attrs.level.is_some()
                    || block.attrs.list_kind.is_some()
                    || block.attrs.depth.is_some()
                {
                    return invalid();
                }
                previous_depth = None;
            }
            BlockKind::Heading => {
                if !block.attrs.level.is_some_and(|v| (1..=6).contains(&v))
                    || block.attrs.list_kind.is_some()
                    || block.attrs.depth.is_some()
                {
                    return invalid();
                }
                previous_depth = None;
            }
            BlockKind::Listitem => {
                let depth = block
                    .attrs
                    .depth
                    .ok_or(ManuscriptError("DOCUMENT_INVALID", None))?;
                if block.attrs.level.is_some()
                    || block.attrs.list_kind.is_none()
                    || !(0..=3).contains(&depth)
                    || depth > previous_depth.map_or(0, |d| d + 1)
                {
                    return invalid();
                }
                previous_depth = Some(depth);
            }
        }
        let mut runs: Vec<TextRun> = Vec::new();
        let mut bytes = 0;
        for mut run in std::mem::take(&mut block.runs) {
            if run
                .text
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return invalid();
            }
            bytes += run.text.len();
            let rank = |m: &Mark| match m.r#type {
                MarkType::Bold => 0,
                MarkType::Italic => 1,
                MarkType::Code => 2,
                MarkType::Link => 3,
            };
            run.marks.sort_by_key(rank);
            for (index, mark) in run.marks.iter().enumerate() {
                if index > 0 && rank(&run.marks[index - 1]) == rank(mark) {
                    return invalid();
                }
                match mark.r#type {
                    MarkType::Link => {
                        let href = mark
                            .href
                            .as_ref()
                            .ok_or(ManuscriptError("DOCUMENT_INVALID", None))?;
                        let url = url::Url::parse(href)
                            .map_err(|_| ManuscriptError("DOCUMENT_INVALID", None))?;
                        if !["http", "https", "mailto"].contains(&url.scheme())
                            || href.chars().any(char::is_control)
                        {
                            return invalid();
                        }
                    }
                    _ => {
                        if mark.href.is_some() {
                            return invalid();
                        }
                    }
                }
            }
            if run.text.is_empty() {
                continue;
            }
            if let Some(last) = runs.last_mut()
                && last.marks == run.marks
            {
                last.text.push_str(&run.text);
            } else {
                runs.push(run);
            }
        }
        block.runs = runs;
        if bytes > MAX_BLOCK_BYTES {
            return Err(ManuscriptError("DOCUMENT_TOO_LARGE", None));
        }
        total += bytes;
    }
    if total > MAX_TEXT_BYTES
        || serde_json::to_vec(state)
            .map_err(|_| ManuscriptError("DOCUMENT_INVALID", None))?
            .len()
            > MAX_DOCUMENT_BYTES
    {
        return Err(ManuscriptError("DOCUMENT_TOO_LARGE", None));
    }
    Ok(*state != before)
}

pub trait MutationPolicy: Send + Sync {
    fn validate(
        &self,
        before: &ManuscriptState,
        after: &ManuscriptState,
        affected: &BTreeSet<String>,
    ) -> Result<()>;
}
pub struct Unrestricted;
impl MutationPolicy for Unrestricted {
    fn validate(
        &self,
        _: &ManuscriptState,
        _: &ManuscriptState,
        _: &BTreeSet<String>,
    ) -> Result<()> {
        Ok(())
    }
}
pub struct Transition {
    pub locks: Option<Vec<String>>,
    pub reviews: Option<Vec<ReviewThread>>,
    pub state: ManuscriptState,
    pub affected: BTreeSet<String>,
    pub normalized: bool,
    pub sources: Option<Vec<Source>>,
    pub planning: Option<PlanningContent>,
    pub planning_metadata: Option<PlanningTaskMetadata>,
}
pub fn envelope(command: &ManuscriptCommand) -> (&str, &str, i64) {
    match command {
        ManuscriptCommand::SetUserLocks {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::SaveReview {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::SetReviewHandled {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::DeleteReviewThread {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::StartReviewTask {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::CancelReviewTask {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::AcceptReviewCandidates {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::DiscardReviewCandidate {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::StartManualDraft {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::UndoProject {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::RedoProject {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::CloseEditGroup {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::AddSourceLink {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::RenameSourceLink {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::AddSourceFile {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::RefreshSourceFile {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::RemoveSource {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::CommitManuscriptImport {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::SavePlanning {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::StartPlanningTask {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::CancelPlanningTask {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::UsePlanningResult {
            request_id,
            project_id,
            expected_working_revision,
            ..
        }
        | ManuscriptCommand::ApplyDocumentEdit {
            request_id,
            project_id,
            expected_working_revision,
            ..
        } => (request_id, project_id, *expected_working_revision),
    }
}
fn index(blocks: &[Block], id: &str) -> Result<usize> {
    blocks
        .iter()
        .position(|b| b.id == id)
        .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))
}
fn destination(blocks: &[Block], after: &Option<String>) -> Result<usize> {
    after
        .as_ref()
        .map_or(Ok(0), |id| index(blocks, id).map(|i| i + 1))
}
// Compare derived section/list ancestry, including newly inserted structural parents.
fn ancestry(blocks: &[Block]) -> BTreeMap<String, Vec<String>> {
    let mut result = BTreeMap::new();
    let mut headings: Vec<&Block> = vec![];
    let mut lists: Vec<&Block> = vec![];
    for b in blocks {
        if b.kind == BlockKind::Heading {
            while headings
                .last()
                .is_some_and(|h| h.attrs.level >= b.attrs.level)
            {
                headings.pop();
            }
        }
        if b.kind != BlockKind::Listitem {
            lists.clear();
        } else {
            while lists.last().is_some_and(|p| p.attrs.depth >= b.attrs.depth) {
                lists.pop();
            }
        }
        result.insert(
            b.id.clone(),
            headings
                .iter()
                .chain(lists.iter())
                .map(|p| p.id.clone())
                .collect(),
        );
        if b.kind == BlockKind::Heading {
            headings.push(b);
        }
        if b.kind == BlockKind::Listitem {
            lists.push(b);
        }
    }
    result
}
fn text(b: &Block) -> String {
    b.runs.iter().map(|r| r.text.as_str()).collect()
}
pub fn apply(
    before: &ManuscriptState,
    command: &ManuscriptCommand,
    identities: &BTreeMap<String, i64>,
    policy: &dyn MutationPolicy,
) -> Result<Transition> {
    let (request, project, expected) = envelope(command);
    if !uuid4(request) || !uuid4(project) {
        return Err(ManuscriptError("INVALID_REQUEST", None));
    }
    if expected != before.working_revision {
        return Err(ManuscriptError("REVISION_CONFLICT", None));
    }
    let mut state = before.clone();
    let mut structural = BTreeSet::new();
    let mut referenced = BTreeSet::new();
    let mut inserted = BTreeSet::new();
    match command {
        ManuscriptCommand::StartManualDraft { .. } => {
            if state.workspace_stage != ManuscriptStateWorkspaceStage::Outline {
                return Err(ManuscriptError("REVISION_CONFLICT", None));
            }
            state.workspace_stage = ManuscriptStateWorkspaceStage::Draft;
        }
        ManuscriptCommand::SetUserLocks { .. }
        | ManuscriptCommand::SaveReview { .. }
        | ManuscriptCommand::SetReviewHandled { .. }
        | ManuscriptCommand::DeleteReviewThread { .. }
        | ManuscriptCommand::StartReviewTask { .. }
        | ManuscriptCommand::CancelReviewTask { .. }
        | ManuscriptCommand::AcceptReviewCandidates { .. }
        | ManuscriptCommand::DiscardReviewCandidate { .. }
        | ManuscriptCommand::SavePlanning { .. }
        | ManuscriptCommand::StartPlanningTask { .. }
        | ManuscriptCommand::CancelPlanningTask { .. }
        | ManuscriptCommand::UsePlanningResult { .. }
        | ManuscriptCommand::AddSourceLink { .. }
        | ManuscriptCommand::RenameSourceLink { .. }
        | ManuscriptCommand::AddSourceFile { .. }
        | ManuscriptCommand::RefreshSourceFile { .. }
        | ManuscriptCommand::RemoveSource { .. }
        | ManuscriptCommand::CommitManuscriptImport { .. }
        | ManuscriptCommand::UndoProject { .. }
        | ManuscriptCommand::RedoProject { .. }
        | ManuscriptCommand::CloseEditGroup { .. } => {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        }
        ManuscriptCommand::ApplyDocumentEdit { payload, .. } => {
            if payload.operations.len() > MAX_OPERATIONS
                || !uuid4(&payload.group.group_id)
                || !uuid4(&payload.group.client_session_id)
                || payload.group.group_sequence < 1
            {
                return Err(ManuscriptError("INVALID_REQUEST", None));
            }
            for op in &payload.operations {
                match op {
                    Primitive::InsertBlock { block, after } => {
                        if !uuid4(&block.id)
                            || identities.contains_key(&block.id)
                            || !inserted.insert(block.id.clone())
                            || state.blocks.iter().any(|b| b.id == block.id)
                        {
                            return invalid();
                        }
                        let pos = destination(&state.blocks, after)?;
                        state.blocks.insert(
                            pos,
                            Block {
                                id: block.id.clone(),
                                kind: block.kind.clone(),
                                attrs: block.attrs.clone(),
                                runs: block.runs.clone(),
                                revision: 1,
                            },
                        );
                    }
                    Primitive::SetBlockContent { id, runs } => {
                        referenced.insert(id.clone());
                        let i = index(&state.blocks, id)?;
                        state.blocks[i].runs = runs.clone();
                    }
                    Primitive::SetBlockAttributes { id, kind, attrs } => {
                        referenced.insert(id.clone());
                        let i = index(&state.blocks, id)?;
                        if state.blocks[i].kind != *kind || state.blocks[i].attrs != *attrs {
                            structural.insert(id.clone());
                        }
                        state.blocks[i].kind = kind.clone();
                        state.blocks[i].attrs = attrs.clone();
                    }
                    Primitive::DeleteBlock { id } => {
                        referenced.insert(id.clone());
                        structural.insert(id.clone());
                        let i = index(&state.blocks, id)?;
                        state.blocks.remove(i);
                    }
                    Primitive::MoveBlocks { ids, after } => {
                        if ids.is_empty()
                            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
                            || after.as_ref().is_some_and(|a| ids.contains(a))
                        {
                            return invalid();
                        }
                        let mut moved = Vec::new();
                        for id in ids {
                            referenced.insert(id.clone());
                            structural.insert(id.clone());
                            moved.push(state.blocks[index(&state.blocks, id)?].clone());
                        }
                        state.blocks.retain(|b| !ids.contains(&b.id));
                        let pos = destination(&state.blocks, after)?;
                        state.blocks.splice(pos..pos, moved);
                    }
                }
            }
            let expected: BTreeMap<_, _> = payload
                .expected_block_revisions
                .iter()
                .map(|r| (r.id.clone(), r.revision))
                .collect();
            if expected.len() != payload.expected_block_revisions.len() {
                return invalid();
            }
            for id in referenced.iter().filter(|id| !inserted.contains(*id)) {
                let old = &before.blocks[index(&before.blocks, id)?];
                if expected.get(id) != Some(&old.revision) {
                    return Err(ManuscriptError("REVISION_CONFLICT", None));
                }
            }
            // A caller may supply a revision precondition superset; it never
            // expands mutation-policy scope or authorizes changes to those IDs.
            for (id, revision) in &expected {
                if before.blocks[index(&before.blocks, id)?].revision != *revision {
                    return Err(ManuscriptError("REVISION_CONFLICT", None));
                }
            }
        }
    }
    let old_index: BTreeMap<_, _> = before.blocks.iter().map(|b| (&b.id, b)).collect();
    let new_index: BTreeMap<_, _> = state.blocks.iter().map(|b| (&b.id, b)).collect();
    // A split must not cut a user-perceived grapheme, even when encoded as primitives.
    for old in &before.blocks {
        if let Some(first) = new_index.get(&old.id).copied() {
            let old_text = text(old);
            let first_text = text(first);
            if old_text.starts_with(&first_text) && first_text.len() < old_text.len() {
                let suffix = &old_text[first_text.len()..];
                if state
                    .blocks
                    .iter()
                    .any(|b| inserted.contains(&b.id) && text(b) == suffix)
                    && !old_text
                        .grapheme_indices(true)
                        .any(|(offset, _)| offset == first_text.len())
                {
                    return invalid();
                }
            }
        }
    }
    drop(new_index);
    // The first body edit and its stage transition share one receipt/history entry.
    // Empty batches (including insert-then-delete) leave an Outline project untouched.
    if before.workspace_stage == ManuscriptStateWorkspaceStage::Outline && !state.blocks.is_empty()
    {
        state.workspace_stage = ManuscriptStateWorkspaceStage::Draft;
    }
    let normalized = normalize(&mut state)?;
    let new_index: BTreeMap<_, _> = state.blocks.iter().map(|b| (&b.id, b)).collect();
    let mut affected = BTreeSet::new();
    for old in &before.blocks {
        if let Some(new) = new_index.get(&old.id).copied() {
            if new != old {
                affected.insert(old.id.clone());
            }
        } else {
            affected.insert(old.id.clone());
        }
    }
    for b in &state.blocks {
        if !old_index.contains_key(&b.id) {
            affected.insert(b.id.clone());
        }
    }
    let old_order: Vec<_> = before
        .blocks
        .iter()
        .filter(|b| new_index.contains_key(&b.id))
        .map(|b| &b.id)
        .collect();
    let new_order: Vec<_> = state
        .blocks
        .iter()
        .filter(|b| old_index.contains_key(&b.id))
        .map(|b| &b.id)
        .collect();
    if old_order != new_order {
        for id in &structural {
            if old_order.iter().position(|v| *v == id) != new_order.iter().position(|v| *v == id) {
                affected.insert(id.clone());
            }
        }
    }
    let old_ancestry = ancestry(&before.blocks);
    let new_ancestry = ancestry(&state.blocks);
    for (id, parents) in &old_ancestry {
        if new_ancestry.get(id).is_some_and(|p| p != parents) {
            affected.insert(id.clone());
        }
    }
    if let ManuscriptCommand::ApplyDocumentEdit { payload, .. } = command {
        for id in &affected {
            if let Some(old) = old_index.get(id).copied()
                && !payload
                    .expected_block_revisions
                    .iter()
                    .any(|r| r.id == *id && r.revision == old.revision)
            {
                return Err(ManuscriptError("REVISION_CONFLICT", None));
            }
        }
    }
    policy.validate(before, &state, &affected)?;
    let changed = state != *before;
    if changed {
        state.working_revision = next_revision(before.working_revision)?;
        for block in &mut state.blocks {
            if affected.contains(&block.id) {
                block.revision = next_revision(*identities.get(&block.id).unwrap_or(&0))?;
            }
        }
    }
    normalize(&mut state)?;
    Ok(Transition {
        locks: None,
        reviews: None,
        state,
        affected,
        normalized,
        sources: None,
        planning: None,
        planning_metadata: None,
    })
}

/// Business-only roots deliberately exclude tokens, receipts, events and runtime rows.
/// Later source/review/lock fields extend this versioned project root and the same cursor.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BusinessSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locks: Vec<String>,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reviews: Vec<ReviewThread>,
    pub workspace_stage: ManuscriptStateWorkspaceStage,
    pub blocks: Vec<NewBlock>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<PlanningContent>,
}
impl BusinessSnapshot {
    pub fn capture(state: &ManuscriptState) -> Self {
        Self {
            version: 4,
            locks: vec![],
            reviews: vec![],
            planning: None,
            sources: vec![],
            workspace_stage: state.workspace_stage.clone(),
            blocks: state
                .blocks
                .iter()
                .map(|b| NewBlock {
                    id: b.id.clone(),
                    kind: b.kind.clone(),
                    attrs: b.attrs.clone(),
                    runs: b.runs.clone(),
                })
                .collect(),
        }
    }
}
/// Restore business fields only; every actual affected identity receives a fresh token.
pub fn restore(
    before: &ManuscriptState,
    target: &BusinessSnapshot,
    identities: &BTreeMap<String, i64>,
    recorded: &BTreeSet<String>,
    policy: &dyn MutationPolicy,
) -> Result<Transition> {
    if !(1..=4).contains(&target.version) {
        return Err(ManuscriptError::history_blocked(
            "SCHEMA_UNSUPPORTED",
            recorded,
        ));
    }
    let old_index: BTreeMap<_, _> = before
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (&b.id, i))
        .collect();
    let mut state = before.clone();
    state.workspace_stage = target.workspace_stage.clone();
    state.blocks = target
        .blocks
        .iter()
        .map(|b| Block {
            id: b.id.clone(),
            kind: b.kind.clone(),
            attrs: b.attrs.clone(),
            runs: b.runs.clone(),
            revision: old_index
                .get(&b.id)
                .map_or(1, |i| before.blocks[*i].revision),
        })
        .collect();
    normalize(&mut state)?;
    let mut affected = BTreeSet::new();
    let old_ancestry = ancestry(&before.blocks);
    let new_ancestry = ancestry(&state.blocks);
    let new_index: BTreeMap<_, _> = state
        .blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (&b.id, i))
        .collect();
    let old_order: Vec<_> = before
        .blocks
        .iter()
        .filter(|b| new_index.contains_key(&b.id))
        .map(|b| &b.id)
        .collect();
    let new_order: Vec<_> = state
        .blocks
        .iter()
        .filter(|b| old_index.contains_key(&b.id))
        .map(|b| &b.id)
        .collect();
    for b in before.blocks.iter().chain(state.blocks.iter()) {
        let old = old_index.get(&b.id).copied();
        let new = new_index.get(&b.id).copied();
        if old.is_none()
            || new.is_none()
            || (old_order != new_order && recorded.contains(&b.id))
            || old
                .zip(new)
                .is_some_and(|(i, j)| before.blocks[i] != state.blocks[j])
            || old_ancestry.get(&b.id) != new_ancestry.get(&b.id)
        {
            affected.insert(b.id.clone());
        }
    }
    policy
        .validate(before, &state, &affected)
        .map_err(|error| ManuscriptError::history_blocked(error.0, &affected))?;
    state.working_revision = next_revision(before.working_revision)?;
    for b in &mut state.blocks {
        if affected.contains(&b.id) {
            b.revision =
                next_revision(*identities.get(&b.id).ok_or_else(|| {
                    ManuscriptError::history_blocked("IDENTITY_MISSING", recorded)
                })?)?;
        }
    }
    normalize(&mut state)?;
    Ok(Transition {
        locks: None,
        reviews: None,
        state,
        affected,
        normalized: false,
        sources: None,
        planning: None,
        planning_metadata: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn state() -> ManuscriptState {
        ManuscriptState {
            manuscript_id: id(),
            schema_version: 1,
            workspace_stage: ManuscriptStateWorkspaceStage::Draft,
            working_revision: 0,
            blocks: vec![],
        }
    }
    #[test]
    fn canonical_runs_preserve_unicode_and_coalesce_without_normalizing_text() {
        let mut s = state();
        s.blocks.push(Block {
            id: id(),
            revision: 1,
            kind: BlockKind::Paragraph,
            attrs: BlockAttrs {
                level: None,
                list_kind: None,
                depth: None,
            },
            runs: vec![
                TextRun {
                    text: "中文 e\u{301}".into(),
                    marks: vec![],
                },
                TextRun {
                    text: " 🐦\n\t".into(),
                    marks: vec![],
                },
            ],
        });
        assert!(normalize(&mut s).unwrap());
        assert_eq!(s.blocks[0].runs[0].text, "中文 e\u{301} 🐦\n\t");
        assert!(!normalize(&mut s).unwrap());
        s.blocks[0].runs[0].text.push('\0');
        assert_eq!(normalize(&mut s).unwrap_err().0, "DOCUMENT_INVALID");
    }
    #[test]
    fn revision_exhaustion_and_closed_wire_variants() {
        assert!(next_revision(MAX_REVISION).is_err());
        assert_eq!(next_revision(9).unwrap(), 10);
        assert!(!uuid4("00000000-0000-0000-0000-000000000000"));
        assert!(!uuid4("00000000-0000-4000-0000-000000000000"));
        let request = serde_json::json!({"type":"StartManualDraft","projectId":id(),"requestId":id(),"expectedWorkingRevision":0,"payload":{"operations":[]}});
        assert!(serde_json::from_value::<ManuscriptCommand>(request).is_err());
        let request = serde_json::json!({"op":"moveBlocks","ids":[],"after":null,"runs":[]});
        assert!(serde_json::from_value::<Primitive>(request).is_err());
    }
}

/// Import is one canonical mutation even when replacement deletes and inserts
/// 10,000 blocks each; the edit-envelope primitive count does not limit imports.
pub fn import_candidate(
    before: &ManuscriptState,
    mut blocks: Vec<Block>,
    append: bool,
    identities: &BTreeMap<String, i64>,
    policy: &dyn MutationPolicy,
) -> Result<Transition> {
    let mut affected = BTreeSet::new();
    for block in &mut blocks {
        if identities.contains_key(&block.id) || !affected.insert(block.id.clone()) {
            return invalid();
        }
        block.revision = 1;
    }
    let mut state = before.clone();
    state.workspace_stage = ManuscriptStateWorkspaceStage::Draft;
    if append {
        state.blocks.extend(blocks);
    } else {
        affected.extend(before.blocks.iter().map(|b| b.id.clone()));
        state.blocks = blocks;
    }
    let normalized = normalize(&mut state)?;
    policy.validate(before, &state, &affected)?;
    state.working_revision = next_revision(before.working_revision)?;
    normalize(&mut state)?;
    Ok(Transition {
        locks: None,
        reviews: None,
        state,
        affected,
        normalized,
        sources: None,
        planning: None,
        planning_metadata: None,
    })
}

#[cfg(test)]
#[test]
fn import_replacement_supports_two_valid_max_block_documents_as_one_mutation() {
    let blocks = || {
        (0..MAX_BLOCKS)
            .map(|_| Block {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                kind: BlockKind::Paragraph,
                attrs: BlockAttrs {
                    level: None,
                    list_kind: None,
                    depth: None,
                },
                runs: vec![],
            })
            .collect::<Vec<_>>()
    };
    let before = ManuscriptState {
        manuscript_id: uuid::Uuid::new_v4().to_string(),
        schema_version: 1,
        workspace_stage: ManuscriptStateWorkspaceStage::Draft,
        working_revision: 1,
        blocks: blocks(),
    };
    let identities = before
        .blocks
        .iter()
        .map(|b| (b.id.clone(), b.revision))
        .collect();
    let result = import_candidate(&before, blocks(), false, &identities, &Unrestricted).unwrap();
    assert_eq!(result.state.blocks.len(), MAX_BLOCKS);
    assert_eq!(result.affected.len(), 2 * MAX_BLOCKS);
}

/// Portable library metadata only. Never interpret this value as a host locator.
pub fn validate_reference_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 4096
        || path
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == ':')
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(ManuscriptError("INVALID_REQUEST", None));
    }
    Ok(())
}
