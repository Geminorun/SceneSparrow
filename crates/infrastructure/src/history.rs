use super::storage::{Result, db};
use super::*;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError, Transition},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
struct Entry {
    id: String,
    before: String,
    after: String,
    affected: BTreeSet<String>,
    label: String,
    group: Option<String>,
}
pub(super) struct Plan {
    pub metadata: HistoryState,
    entries: Vec<Entry>,
    pub changed: bool,
    base_history_revision: i64,
    base_cursor: i64,
    group: Option<(EditGroup, Option<String>)>,
    close: bool,
    close_target: Option<String>,
    noop_group: Option<EditGroup>,
    now: i64,
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
impl SqliteProjectRepository {
    pub(super) fn verify_history(&self, c: &Connection, state: &ManuscriptState) -> Result<()> {
        let metadata = Self::history_metadata(c)?;
        let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        let missing: i64 = if version >= 7 {
            db(c.query_row("SELECT COUNT(*) FROM history_entries h LEFT JOIN history_entry_identities i ON i.position=h.position WHERE i.entry_id IS NULL",[],|r|r.get(0)))?
        } else {
            0
        };
        if missing != 0 {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        let mut stmt =
            db(c.prepare("SELECT before_hash,after_hash FROM history_entries ORDER BY position"))?;
        let mut snapshots = vec![];
        let mut previous: Option<String> = None;
        for row in db(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?
        {
            let (before, after) = db(row)?;
            if previous.as_ref().is_some_and(|p| p != &before) {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            for digest in [&before, &after] {
                let snapshot = self.read_business(digest)?;
                let mut check = state.clone();
                check.workspace_stage = snapshot.workspace_stage.clone();
                check.blocks = snapshot
                    .blocks
                    .iter()
                    .map(|b| Block {
                        id: b.id.clone(),
                        kind: b.kind.clone(),
                        attrs: b.attrs.clone(),
                        runs: b.runs.clone(),
                        revision: 1,
                    })
                    .collect();
                manuscript::normalize(&mut check)
                    .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                if snapshots.is_empty() || digest == &after {
                    snapshots.push(snapshot);
                }
            }
            previous = Some(after);
        }
        if !snapshots.is_empty()
            && snapshots.get(metadata.cursor as usize) != Some(&Self::business(c, state)?)
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        Ok(())
    }
    pub(super) fn history_metadata(c: &Connection) -> Result<HistoryState> {
        let (revision, cursor): (i64, i64) = db(c.query_row(
            "SELECT history_revision,cursor FROM history_cursor WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let count: i64 = db(c.query_row("SELECT COUNT(*) FROM history_entries", [], |r| r.get(0)))?;
        if cursor > count || !(0..=manuscript::MAX_REVISION).contains(&revision) {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        let label = |position| {
            db(c.query_row(
                "SELECT label FROM history_entries WHERE position=?1",
                [position],
                |r| r.get::<_, String>(0),
            )
            .optional())
        };
        Ok(HistoryState {
            working_revision: db(c
                .query_row(
                    "SELECT working_revision FROM manuscripts WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .optional())?
            .ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?,
            history_revision: revision,
            cursor,
            undo_count: cursor,
            redo_count: count - cursor,
            undo_label: label(cursor)?,
            redo_label: label(cursor + 1)?,
        })
    }
    pub(super) fn history_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        let (expected_revision, expected_cursor, redo) = match command {
            ManuscriptCommand::UndoProject {
                expected_history_revision,
                expected_cursor,
                ..
            } => (*expected_history_revision, *expected_cursor, false),
            ManuscriptCommand::RedoProject {
                expected_history_revision,
                expected_cursor,
                ..
            } => (*expected_history_revision, *expected_cursor, true),
            ManuscriptCommand::CloseEditGroup {
                expected_history_revision,
                expected_cursor,
                payload,
                ..
            } => {
                let metadata = Self::history_metadata(c)?;
                if metadata.history_revision != *expected_history_revision
                    || metadata.cursor != *expected_cursor
                {
                    return Err(ManuscriptError("HISTORY_CONFLICT", None));
                }
                let group=db(c.query_row("SELECT client_session_id,group_sequence FROM edit_groups WHERE group_id=?1",[&payload.group_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional())?;
                if !manuscript::uuid4(&payload.group_id)
                    || !manuscript::uuid4(&payload.client_session_id)
                    || group.is_none_or(|(s, q)| {
                        s != payload.client_session_id || q != payload.group_sequence
                    })
                {
                    return Err(ManuscriptError("INVALID_REQUEST", None));
                }
                return Ok(Transition {
                    source_hash: None,
                    locks: None,
                    reviews: None,
                    state: before.clone(),
                    affected: BTreeSet::new(),
                    normalized: false,
                    sources: None,
                    planning: None,
                    planning_metadata: None,
                });
            }
            ManuscriptCommand::AddSourceLink { .. }
            | ManuscriptCommand::RenameSourceLink { .. }
            | ManuscriptCommand::AddSourceFile { .. }
            | ManuscriptCommand::RefreshSourceFile { .. }
            | ManuscriptCommand::RemoveSource { .. }
            | ManuscriptCommand::CommitManuscriptImport { .. } => {
                return self.source_transition(c, command, before, identities);
            }
            ManuscriptCommand::SaveReview { .. }
            | ManuscriptCommand::SetReviewHandled { .. }
            | ManuscriptCommand::DeleteReviewThread { .. }
            | ManuscriptCommand::CancelReviewTask { .. }
            | ManuscriptCommand::AcceptReviewCandidates { .. }
            | ManuscriptCommand::DiscardReviewCandidate { .. }
            | ManuscriptCommand::StartReviewTask { .. } => {
                return self.review_transition(c, command, before, identities);
            }
            ManuscriptCommand::SavePlanning { .. }
            | ManuscriptCommand::UsePlanningResult { .. }
            | ManuscriptCommand::CancelPlanningTask { .. } => {
                return self.planning_transition(c, command, before, identities);
            }
            ManuscriptCommand::SetUserLocks { .. } => {
                return self.lock_transition(c, command, before);
            }
            _ => return manuscript::apply(before, command, identities, self.policy.as_ref()),
        };
        let metadata = Self::history_metadata(c)?;
        if metadata.history_revision != expected_revision || metadata.cursor != expected_cursor {
            return Err(ManuscriptError("HISTORY_CONFLICT", None));
        }
        if (redo && metadata.redo_count == 0) || (!redo && metadata.undo_count == 0) {
            return Err(ManuscriptError("HISTORY_EMPTY", None));
        }
        let position = metadata.cursor + i64::from(redo);
        let (before_hash, after_hash, affected): (String, String, String) = db(c.query_row(
            "SELECT before_hash,after_hash,affected_json FROM history_entries WHERE position=?1",
            [position],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ))?;
        let read = |digest: &str| self.read_business(digest);
        let (expected, target) = if redo {
            (&before_hash, &after_hash)
        } else {
            (&after_hash, &before_hash)
        };
        if read(expected)? != Self::business(c, before)? {
            return Err(ManuscriptError::history_blocked(
                "REPLAY_CONFLICT",
                &db(serde_json::from_str(&affected))?,
            ));
        }
        let target = read(target)?;
        let mut transition = manuscript::restore(
            before,
            &target,
            identities,
            &db(serde_json::from_str(&affected))?,
            self.policy.as_ref(),
        )?;
        self.restore_sources(c, before, &mut transition, &target, identities)?;
        self.restore_planning(c, &mut transition, &target)?;
        self.restore_reviews(c, &mut transition, &target)?;
        transition.source_hash = target.source_hash.clone();
        transition.locks = Some(target.locks.clone());
        Ok(transition)
    }

    pub(super) fn history_plan(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        transition: &Transition,
    ) -> Result<Plan> {
        let metadata = Self::history_metadata(c)?;
        let mut entries = vec![];
        let mut stmt=db(c.prepare("SELECT h.before_hash,h.after_hash,h.affected_json,h.label,h.group_id,i.entry_id FROM history_entries h JOIN history_entry_identities i ON i.position=h.position ORDER BY h.position"))?;
        let rows = db(stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
            ))
        }))?;
        for row in rows {
            let (before, after, affected, label, group, id) = db(row)?;
            entries.push(Entry {
                id,
                before,
                after,
                affected: db(serde_json::from_str(&affected))?,
                label,
                group,
            });
        }
        let base_history_revision = metadata.history_revision;
        let base_cursor = metadata.cursor;
        let mut plan = Plan {
            base_history_revision,
            base_cursor,
            metadata,
            entries,
            changed: false,
            group: None,
            close: false,
            close_target: None,
            noop_group: None,
            now: now(),
        };
        let business_changed = transition.state.working_revision != before.working_revision;
        if business_changed {
            manuscript::next_revision(plan.metadata.history_revision)?;
        }
        let retained_before = if business_changed {
            let endpoint = if plan.metadata.cursor == 0 {
                plan.entries.first().map(|e| e.before.clone())
            } else {
                plan.entries
                    .get(plan.metadata.cursor as usize - 1)
                    .map(|e| e.after.clone())
            };
            if let Some(endpoint) = endpoint {
                if self.read_business(&endpoint)? != Self::business(c, before)? {
                    return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
                }
                Some(endpoint)
            } else {
                Some(self.object(&db(serde_json::to_vec(&Self::business(c, before)?))?)?)
            }
        } else {
            None
        };
        if let Some(g) = match command {
            ManuscriptCommand::ApplyDocumentEdit { payload, .. } => Some(&payload.group),
            ManuscriptCommand::SavePlanning { payload, .. } => Some(&payload.group),
            _ => None,
        } {
            let previous=db(c.query_row("SELECT client_session_id,group_sequence,kind,closed,scope_block_id,last_commit_ms FROM edit_groups WHERE group_id=?1",[&g.group_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,i64>(5)?))).optional())?;
            let kind = if g.kind == EditGroupKind::Typing {
                "typing"
            } else {
                "discrete"
            };
            if previous.as_ref().is_some_and(|(s, q, k, closed, _, _)| {
                *closed
                    || s != &g.client_session_id
                    || q.checked_add(1) != Some(g.group_sequence)
                    || k != kind
            }) || (previous.is_none() && g.group_sequence != 1)
            {
                return Err(ManuscriptError("INVALID_REQUEST", None));
            }
            if business_changed {
                let scope = if matches!(command, ManuscriptCommand::SavePlanning { .. })
                    && kind == "typing"
                {
                    self.planning_typing_scope(c, transition)?
                } else {
                    typing_scope(before, transition, kind)
                };
                let merge = previous.as_ref().is_some_and(|(_, _, _, _, old_scope, _)| {
                    scope.is_some() && old_scope == &scope
                }) && plan.metadata.redo_count == 0
                    && plan
                        .entries
                        .last()
                        .is_some_and(|e| e.group.as_ref() == Some(&g.group_id));
                let before_hash = retained_before
                    .clone()
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                let after_hash = self.object(&db(serde_json::to_vec(&Self::business_after(
                    c, transition,
                )?))?)?;
                if merge {
                    let entry = plan
                        .entries
                        .last_mut()
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                    entry.after = after_hash;
                    entry.affected.extend(transition.affected.clone());
                } else {
                    plan.entries.truncate(plan.metadata.cursor as usize);
                    plan.entries.push(Entry {
                        id: uuid::Uuid::new_v4().to_string(),
                        before: before_hash,
                        after: after_hash,
                        affected: transition.affected.clone(),
                        label: if scope.is_some() { "typing" } else { "edit" }.into(),
                        group: Some(g.group_id.clone()),
                    });
                    if plan.entries.len() > 5 {
                        plan.entries.remove(0);
                    }
                }
                plan.metadata.cursor = plan.entries.len() as i64;
                plan.group = Some((g.clone(), scope));
                plan.changed = true;
                plan.close = true;
            } else {
                plan.noop_group = Some(g.clone());
            }
        } else if business_changed {
            plan.close = true;
            plan.changed = true;
            match command {
                ManuscriptCommand::UndoProject { .. } => plan.metadata.cursor -= 1,
                ManuscriptCommand::RedoProject { .. } => plan.metadata.cursor += 1,
                _ => {
                    plan.entries.truncate(plan.metadata.cursor as usize);
                    plan.entries.push(Entry {
                        id: uuid::Uuid::new_v4().to_string(),
                        before: retained_before
                            .clone()
                            .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?,
                        after: self.object(&db(serde_json::to_vec(&Self::business_after(
                            c, transition,
                        )?))?)?,
                        affected: transition.affected.clone(),
                        label: match command {
                            ManuscriptCommand::AddSourceLink { .. }
                            | ManuscriptCommand::AddSourceFile { .. } => "addSource",
                            ManuscriptCommand::RenameSourceLink { .. } => "renameSource",
                            ManuscriptCommand::RefreshSourceFile { .. } => "refreshSource",
                            ManuscriptCommand::RemoveSource { .. } => "removeSource",
                            ManuscriptCommand::SavePlanning { .. } => "planning",
                            ManuscriptCommand::SetUserLocks { .. } => "locks",
                            ManuscriptCommand::SaveReview { .. }
                            | ManuscriptCommand::SetReviewHandled { .. }
                            | ManuscriptCommand::DeleteReviewThread { .. } => "review",
                            ManuscriptCommand::AcceptReviewCandidates { .. } => "acceptReview",
                            ManuscriptCommand::DiscardReviewCandidate { .. } => "discardReview",
                            ManuscriptCommand::UsePlanningResult { .. } => "generation",
                            ManuscriptCommand::CommitManuscriptImport { .. } => "import",
                            _ => "startDraft",
                        }
                        .into(),
                        group: None,
                    });
                    if plan.entries.len() > 5 {
                        plan.entries.remove(0);
                    }
                    plan.metadata.cursor = plan.entries.len() as i64;
                }
            }
        } else if let ManuscriptCommand::CloseEditGroup { payload, .. } = command {
            let closed: bool = db(c.query_row(
                "SELECT closed FROM edit_groups WHERE group_id=?1",
                [&payload.group_id],
                |r| r.get(0),
            ))?;
            plan.close = !closed;
            plan.changed = !closed;
            plan.close_target = Some(payload.group_id.clone());
        }
        if plan.changed {
            plan.metadata.history_revision =
                manuscript::next_revision(plan.metadata.history_revision)?;
        }
        plan.metadata.working_revision = transition.state.working_revision;
        plan.metadata.undo_count = plan.metadata.cursor;
        plan.metadata.redo_count = plan.entries.len() as i64 - plan.metadata.cursor;
        plan.metadata.undo_label = plan
            .entries
            .get(plan.metadata.cursor.wrapping_sub(1) as usize)
            .map(|e| e.label.clone());
        plan.metadata.redo_label = plan
            .entries
            .get(plan.metadata.cursor as usize)
            .map(|e| e.label.clone());
        Ok(plan)
    }
}
fn typing_scope(before: &ManuscriptState, t: &Transition, kind: &str) -> Option<String> {
    if kind != "typing" || t.affected.len() != 1 {
        return None;
    }
    let id = t.affected.first()?;
    let after = t.state.blocks.iter().find(|b| &b.id == id)?;
    if let Some(old) = before.blocks.iter().find(|b| &b.id == id) {
        if old.kind != after.kind
            || old.attrs != after.attrs
            || before
                .blocks
                .iter()
                .map(|b| &b.id)
                .ne(t.state.blocks.iter().map(|b| &b.id))
        {
            return None;
        }
        let marks = |b: &Block| {
            let mut values = vec![];
            for r in &b.runs {
                if !values.contains(&r.marks) {
                    values.push(r.marks.clone());
                }
            }
            values
        };
        if !old.runs.is_empty() && !after.runs.is_empty() && marks(old) != marks(after) {
            return None;
        }
    } else if before.blocks.len() + 1 != t.state.blocks.len() || after.kind != BlockKind::Paragraph
    {
        return None;
    }
    Some(id.clone())
}
impl Plan {
    pub(super) fn current_entry_id(&self) -> Option<&str> {
        self.entries
            .get(self.metadata.cursor.checked_sub(1)? as usize)
            .map(|e| e.id.as_str())
    }
    pub(super) fn recheck(&self, c: &Connection) -> Result<()> {
        let current = SqliteProjectRepository::history_metadata(c)?;
        if current.history_revision != self.base_history_revision
            || current.cursor != self.base_cursor
        {
            return Err(ManuscriptError("HISTORY_CONFLICT", None));
        }
        Ok(())
    }
    pub(super) fn commit(&self, c: &Connection) -> Result<()> {
        if let Some(g) = &self.noop_group {
            db(c.execute("INSERT INTO edit_groups(group_id,client_session_id,group_sequence,kind,before_hash,after_hash,closed) VALUES(?1,?2,?3,?4,NULL,'',0) ON CONFLICT(group_id) DO UPDATE SET group_sequence=excluded.group_sequence",params![g.group_id,g.client_session_id,g.group_sequence,if g.kind==EditGroupKind::Typing{"typing"}else{"discrete"}]))?;
        }
        if !self.changed {
            return Ok(());
        }
        db(c.execute("DELETE FROM history_entries", []))?;
        for (i, e) in self.entries.iter().enumerate() {
            db(c.execute(
                "INSERT INTO history_entries VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    i + 1,
                    e.before,
                    e.after,
                    db(serde_json::to_string(&e.affected))?,
                    e.label,
                    e.group
                ],
            ))?;
            db(c.execute(
                "INSERT INTO history_entry_identities VALUES(?1,?2)",
                params![i + 1, e.id],
            ))?;
        }
        db(c.execute(
            "UPDATE history_cursor SET history_revision=?1,cursor=?2",
            params![self.metadata.history_revision, self.metadata.cursor],
        ))?;
        if self.close {
            if let Some(id) = &self.close_target {
                db(c.execute("UPDATE edit_groups SET closed=1,before_hash=NULL,after_hash='' WHERE group_id=?1 AND closed=0",[id]))?;
            } else {
                db(c.execute(
                    "UPDATE edit_groups SET closed=1,before_hash=NULL,after_hash='' WHERE closed=0",
                    [],
                ))?;
            }
        }
        if let Some((g, scope)) = &self.group {
            let entry = self
                .entries
                .last()
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            db(c.execute("INSERT INTO edit_groups(group_id,client_session_id,group_sequence,kind,before_hash,after_hash,closed,scope_block_id,last_commit_ms) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?8) ON CONFLICT(group_id) DO UPDATE SET group_sequence=excluded.group_sequence,before_hash=excluded.before_hash,after_hash=excluded.after_hash,closed=0,scope_block_id=excluded.scope_block_id,last_commit_ms=excluded.last_commit_ms",params![g.group_id,g.client_session_id,g.group_sequence,if g.kind==EditGroupKind::Typing{"typing"}else{"discrete"},entry.before,entry.after,scope,self.now]))?;
        }
        Ok(())
    }
}
