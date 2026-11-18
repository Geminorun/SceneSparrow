//! Review-owned application adapter. Generic AI stores results before projection.
use crate::{
    SqliteProjectRepository,
    ai::execution::AiUnitOfWork,
    manuscript::{Result, db, hash},
};
use rusqlite::{Connection, OptionalExtension, params};
use scenesparrow_application::ai::*;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError, Transition},
    planning::{self, ensure},
    review,
};
use std::collections::{BTreeMap, BTreeSet};
type ReviewTaskRow = (String, String, Option<String>, Option<String>, i64);
type VisualArtifacts = Vec<(AiArtifact, Vec<u8>)>;
fn ai<T>(v: scenesparrow_domain::ai::Result<T>) -> Result<T> {
    v.map_err(|e| ManuscriptError(e.0, None))
}
fn to_ai(e: ManuscriptError) -> scenesparrow_domain::ai::AiError {
    scenesparrow_domain::ai::AiError(e.0)
}
pub struct ReviewCoordinator;
impl ConsumerCoordinator for ReviewCoordinator {
    fn name(&self) -> &str {
        "script-review"
    }
    fn cancel(
        &self,
        uow: &mut dyn ProjectUnitOfWork,
        run: &AiRun,
    ) -> scenesparrow_domain::ai::Result<bool> {
        uow.fence_consumer(self.name(), &run.binding_id)
    }
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Context {
    pub thread: ReviewThread,
    pub base: ManuscriptState,
    pub evidence: Vec<PlanningEvidence>,
    pub tokens: String,
    pub request_hash: String,
    pub conversation: Vec<ReviewMessage>,
}
pub(crate) struct PreparedReviewRecord {
    thread: ReviewThread,
    prior: Option<ReviewThread>,
    json: String,
    request_hash: String,
    rebound: Option<(ReviewCandidate, String, Option<Context>)>,
}
pub(crate) struct PreparedReviews {
    records: Vec<PreparedReviewRecord>,
    threads: Vec<ReviewThread>,
    pairs: BTreeMap<String, String>,
}
impl SqliteProjectRepository {
    pub(crate) fn review_threads(c: &Connection) -> Result<Vec<ReviewThread>> {
        let mut s = db(c.prepare("SELECT user_json FROM review_threads ORDER BY id"))?;
        db(s.query_map([], |r| r.get::<_, String>(0)))?
            .map(|v| db(serde_json::from_str(&db(v)?)))
            .collect()
    }
    fn thread(c: &Connection, id: &str) -> Result<ReviewThread> {
        let json: Option<String> = db(c
            .query_row(
                "SELECT user_json FROM review_threads WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        let thread: ReviewThread = db(serde_json::from_str(
            &json.ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?,
        ))?;
        Ok(thread)
    }
    fn active(c: &Connection, id: &str) -> Result<bool> {
        db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_tasks WHERE thread_id=?1 AND application='pending')",[id],|r|r.get(0)))
    }
    fn candidate_at(&self, c: &Connection, id: &str) -> Result<ReviewCandidate> {
        let (payload, status): (Option<String>, String) = db(c
            .query_row(
                "SELECT payload_hash,status FROM review_candidates WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?
        .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
        let mut candidate: ReviewCandidate = db(serde_json::from_slice(
            &self.read_object(&payload.ok_or(ManuscriptError("CANDIDATE_STALE", None))?)?,
        ))?;
        candidate.status = status;
        let binding: Option<String> = db(c
            .query_row(
                "SELECT context_hash FROM review_candidate_bindings WHERE candidate_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(h) = binding {
            let ctx: Context = db(serde_json::from_slice(&self.read_object(&h)?))?;
            candidate.before = ctx.base.blocks;
            candidate.request_version = ctx.thread.request_version;
        }
        Ok(candidate)
    }
    fn current_candidate(&self, c: &Connection, id: &str) -> Result<Option<ReviewCandidate>> {
        let candidate:Option<String>=db(c.query_row("SELECT id FROM review_candidates WHERE thread_id=?1 AND status IN ('pending','stale') ORDER BY rowid DESC LIMIT 1",[id],|r|r.get(0)).optional())?;
        candidate.map(|id| self.candidate_at(c, &id)).transpose()
    }
    pub fn read_reviews(&self, after: Option<&str>) -> Result<ReviewPage> {
        if let Some(id) = after {
            ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        }
        let c = db(self.connection.lock())?;
        let mut stmt = db(
            c.prepare("SELECT id,user_json FROM review_threads WHERE deleted=0 AND id>?1 ORDER BY id LIMIT 41")
        )?;
        let mut rows = db(stmt.query_map([after.unwrap_or("")], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }))?
        .map(db)
        .collect::<Result<Vec<_>>>()?;
        let mut next_cursor = if rows.len() > 40 {
            rows.pop();
            rows.last().map(|r| r.0.clone())
        } else {
            None
        };
        let mut cards = vec![];
        let mut bytes = 0;
        for (id, json) in rows {
            let mut thread: ReviewThread = db(serde_json::from_str(&json))?;
            self.hydrate_review_thread(&mut thread)?;
            if thread.deleted {
                continue;
            }
            let candidate = self
                .current_candidate(&c, &id)?
                .map(Self::candidate_summary);
            let task:Option<ReviewTaskRow>=db(c.query_row("SELECT run_id,application,error,answer,request_version FROM review_tasks WHERE thread_id=?1 ORDER BY rowid DESC LIMIT 1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional())?;
            let task = task
                .map(|(id, application, error, answer, request_version)| {
                    let answer = if request_version == thread.request_version {
                        answer
                    } else {
                        None
                    };
                    Ok(ReviewTask {
                        request_version,
                        run: ai(Self::ai_run(&c, &id))?,
                        application,
                        error,
                        answer,
                    })
                })
                .transpose()?;
            let mut source_comparisons = vec![];
            if !thread.handled {
                for range in &thread.anchor.ranges {
                    let h:Option<String>=db(c.query_row("SELECT payload_hash FROM review_comparisons WHERE block_id=?1 AND candidate_id IS NULL",[&range.block_id],|r|r.get(0)).optional())?.flatten();
                    if let Some(h) = h {
                        source_comparisons.push(Self::source_summary(db(serde_json::from_slice(
                            &self.read_object(&h)?,
                        ))?));
                    }
                }
            }
            let answer=db(c.query_row("SELECT id,text,request_version FROM review_messages WHERE thread_id=?1 AND request_version=?2 AND author='ai' ORDER BY sequence DESC LIMIT 1",params![thread.id,thread.request_version],|r|Ok(ReviewAnswer{run_id:r.get(0)?,text:r.get(1)?,request_version:r.get(2)?})).optional())?;
            let card = ReviewCard {
                answer,
                thread,
                candidate,
                task,
                source_comparisons,
            };
            let size = db(serde_json::to_vec(&card))?.len();
            if bytes + size > 8 * 1024 * 1024 && !cards.is_empty() {
                next_cursor = cards.last().map(|c: &ReviewCard| c.thread.id.clone());
                break;
            }
            ensure(size <= 8 * 1024 * 1024, "INPUT_TOO_LARGE")?;
            bytes += size;
            cards.push(card);
        }
        Ok(ReviewPage { cards, next_cursor })
    }
    fn context(&self, c: &Connection, thread: &ReviewThread) -> Result<(Context, VisualArtifacts)> {
        let mut hydrated = thread.clone();
        self.hydrate_review_thread(&mut hydrated)?;
        let thread = &hydrated;
        let state = self.load(c)?;
        review::validate_anchor(&state, &thread.anchor)?;
        let mut base = state;
        let ids = Self::scope(thread);
        base.blocks.retain(|b| ids.contains(&b.id));
        let mut p = planning::empty();
        p.evidence = thread.evidence.clone();
        let (evidence, visuals, _) = self.manifest(c, &p)?;
        Ok((
            Context {
                thread: thread.clone(),
                base,
                evidence,
                tokens: Self::review_tokens(c, thread)?,
                request_hash: Self::request_hash(thread)?,
                conversation: vec![],
            },
            visuals,
        ))
    }
    fn scope(t: &ReviewThread) -> BTreeSet<String> {
        let mut ids = t
            .anchor
            .ranges
            .iter()
            .map(|r| r.block_id.clone())
            .collect::<BTreeSet<_>>();
        if let Some(s) = &t.anchor.slot {
            ids.insert(s.before_id.clone());
            if let Some(id) = &s.after_id {
                ids.insert(id.clone());
            }
        }
        ids
    }
    fn review_dependencies(&self, c: &Connection, ctx: &Context) -> Result<()> {
        let t = Self::thread(c, &ctx.thread.id)?;
        ensure(
            !t.deleted
                && t.request_version == ctx.thread.request_version
                && t.text == ctx.thread.text
                && t.language == ctx.thread.language
                && t.evidence == ctx.thread.evidence,
            "REVIEW_VERSION_CONFLICT",
        )?;
        let state = self.load(c)?;
        for b in &ctx.base.blocks {
            ensure(
                state.blocks.iter().find(|v| v.id == b.id) == Some(b),
                "CANDIDATE_STALE",
            )?;
        }
        review::validate_anchor(&state, &ctx.thread.anchor)?;
        if let Some(slot) = &ctx.thread.anchor.slot {
            review::validate_slot(&state, slot)?;
        }
        let mut p = planning::empty();
        p.evidence = t.evidence;
        let (manifest, _, _) = self.manifest(c, &p)?;
        ensure(manifest == ctx.evidence, "CANDIDATE_STALE")
    }
    fn load_context(&self, c: &Connection, run: &str) -> Result<Context> {
        let h: String = db(c.query_row(
            "SELECT context_hash FROM review_tasks WHERE run_id=?1",
            [run],
            |r| r.get(0),
        ))?;
        db(serde_json::from_slice(&self.read_object(&h)?))
    }
    pub(crate) fn guard_reviews(
        &self,
        c: &Connection,
        _command: &ManuscriptCommand,
        _before: &ManuscriptState,
        t: &Transition,
    ) -> Result<()> {
        let result = (|| -> Result<()> {
            for id in &t.affected {
                // The task keeps immutable evidence; only its future applicability is invalidated.
                if let ManuscriptCommand::RefreshSourceFile { payload, .. } = _command
                    && id == &payload.source_id
                {
                    continue;
                }

                ensure(
                    !db(c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM review_reservations WHERE block_id=?1)",
                        [id],
                        |r| r.get::<_, bool>(0),
                    ))?,
                    "TASK_USING_CONTENT",
                )?;
            }
            if _before.blocks != t.state.blocks {
                let mut stmt=db(c.prepare("SELECT slot_heading,slot_after FROM review_tasks WHERE application='pending' AND slot_heading IS NOT NULL"))?;
                let slots = db(stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                }))?
                .map(db)
                .collect::<Result<Vec<_>>>()?;
                for (heading, after) in slots {
                    let slot = ReviewSlot {
                        heading_id: heading.clone(),
                        before_id: heading,
                        after_id: after,
                    };
                    ensure(
                        review::validate_slot(&t.state, &slot).is_ok(),
                        "TASK_USING_CONTENT",
                    )?;
                }
            }
            Ok(())
        })();
        result.map_err(|error| {
            if matches!(
                _command,
                ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
            ) {
                ManuscriptError::history_blocked(error.0, &t.affected)
            } else {
                error
            }
        })
    }

    pub(crate) fn review_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        ensure(
            before.workspace_stage == ManuscriptStateWorkspaceStage::Draft,
            "STAGE_CONFLICT",
        )?;
        let mut threads = Self::review_threads(c)?;
        let mut state = before.clone();
        let mut affected = BTreeSet::new();
        let mut changed = true;
        match command {
            ManuscriptCommand::SaveReview { payload, .. } => {
                review::validate_thread(&payload.thread)?;
                ensure(
                    !payload.thread.handled && !payload.thread.deleted,
                    "INVALID_REQUEST",
                )?;
                let mut thread = payload.thread.clone();
                self.prepare_review_thread_quotes(&mut thread)?;
                if let Some(old) = threads.iter_mut().find(|t| t.id == thread.id) {
                    ensure(
                        old.request_version == payload.expected_request_version
                            && !old.deleted
                            && old.kind == thread.kind,
                        "REVIEW_VERSION_CONFLICT",
                    )?;
                    if old.anchor.state == "mapped"
                        || Self::stored_review_thread(&thread).anchor != old.anchor
                    {
                        review::validate_anchor(before, &payload.thread.anchor)?;
                    }
                    thread.decision = old.decision.clone();
                    thread.user_message_ids = old.user_message_ids.clone();
                    if review::snapshot(&[thread.clone()])
                        == review::snapshot(std::slice::from_ref(old))
                    {
                        changed = false;
                    } else {
                        thread.request_version = manuscript::next_revision(old.request_version)?;
                        thread
                            .user_message_ids
                            .push(manuscript::envelope(command).0.into());
                        *old = thread;
                    }
                } else {
                    ensure(
                        payload.expected_request_version == 0
                            && threads.iter().filter(|t| !t.deleted).count() < 2000,
                        "REVIEW_VERSION_CONFLICT",
                    )?;
                    review::validate_anchor(before, &payload.thread.anchor)?;
                    ensure(thread.decision.is_none(), "INVALID_REQUEST")?;
                    thread.request_version = 1;
                    thread.user_message_ids = vec![manuscript::envelope(command).0.into()];
                    threads.push(thread);
                    threads.sort_by(|a, b| a.id.cmp(&b.id));
                }
            }
            ManuscriptCommand::SetReviewHandled { payload, .. } => {
                let old = threads
                    .iter_mut()
                    .find(|t| t.id == payload.thread_id && !t.deleted)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                ensure(
                    old.request_version == payload.request_version,
                    "REVIEW_VERSION_CONFLICT",
                )?;
                ensure(
                    self.current_candidate(c, &old.id)?.is_none(),
                    "PENDING_CANDIDATE",
                )?;
                ensure(
                    old.kind == ReviewThreadKind::Question || !Self::active(c, &old.id)?,
                    "REVIEW_TASK_ACTIVE",
                )?;
                changed = old.handled != payload.handled;
                old.handled = payload.handled;
            }
            ManuscriptCommand::DeleteReviewThread { payload, .. } => {
                let old = threads
                    .iter_mut()
                    .find(|t| t.id == payload.thread_id && !t.deleted)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                ensure(
                    old.request_version == payload.request_version,
                    "REVIEW_VERSION_CONFLICT",
                )?;
                ensure(
                    payload.discard_candidate || self.current_candidate(c, &old.id)?.is_none(),
                    "PENDING_CANDIDATE",
                )?;
                old.deleted = true;
                old.request_version = manuscript::next_revision(old.request_version)?;
            }
            ManuscriptCommand::CancelReviewTask { payload, .. } => {
                let old = threads
                    .iter()
                    .find(|t| t.id == payload.thread_id && !t.deleted)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                ensure(
                    old.request_version == payload.request_version,
                    "REVIEW_VERSION_CONFLICT",
                )?;
                changed = false;
            }
            ManuscriptCommand::DiscardReviewCandidate { payload, .. } => {
                let candidate = self.candidate_at(c, &payload.candidate.id)?;
                ensure(
                    candidate.version == payload.candidate.version
                        && matches!(candidate.status.as_str(), "pending" | "stale"),
                    "CANDIDATE_STALE",
                )?;
                ensure(
                    !Self::active(c, &candidate.thread_id)?,
                    "REVIEW_TASK_ACTIVE",
                )?;
                let old = threads
                    .iter_mut()
                    .find(|t| t.id == candidate.thread_id && !t.deleted)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                // Discard is a user history operation. The note stays open for a new request.
                old.decision = Some(ReviewUserDecision {
                    candidate_id: candidate.id,
                    decision: ReviewUserDecisionDecision::Discarded,
                });
            }
            ManuscriptCommand::AcceptReviewCandidates { payload, .. } => {
                ensure(
                    !payload.candidates.is_empty()
                        && payload.candidates.len() <= 100
                        && Self::history_metadata(c)?.history_revision
                            == payload.expected_history_revision,
                    "HISTORY_CONFLICT",
                )?;
                let mut seen = BTreeSet::new();
                let mut claims = BTreeSet::new();
                let mut operations = vec![];
                let mut revisions = vec![];
                let mut conflicts = vec![];
                let mut first_error = None;
                for reference in &payload.candidates {
                    let mut conflict_scope = vec![];
                    let operation_start = operations.len();
                    let revision_start = revisions.len();
                    let validation = (|| -> Result<()> {
                        ensure(seen.insert(reference.id.clone()), "CANDIDATE_INVALID")?;
                        let candidate = self.candidate_at(c, &reference.id)?;
                        ensure(
                            candidate.version == reference.version && candidate.status == "pending",
                            "CANDIDATE_STALE",
                        )?;
                        ensure(
                            !Self::active(c, &candidate.thread_id)?,
                            "REVIEW_TASK_ACTIVE",
                        )?;
                        let ctx = self.candidate_context(c, &candidate)?;
                        conflict_scope = Self::scope(&ctx.thread).into_iter().collect();
                        self.review_dependencies(c, &ctx)?;
                        ensure(
                            ctx.thread.request_version == candidate.request_version
                                && ctx.thread.id == candidate.thread_id,
                            "CANDIDATE_INVALID",
                        )?;
                        let run = ai(Self::ai_run(c, &candidate.run_id))?;
                        let applied:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_tasks WHERE run_id=?1 AND application='applied')",[&candidate.run_id],|r|r.get(0)))?;
                        ensure(
                            run.status == AiRunStatus::Succeeded && applied,
                            "CANDIDATE_INVALID",
                        )?;
                        for id in Self::scope(&ctx.thread) {
                            ensure(claims.insert(id.clone()), "CANDIDATE_OVERLAP")?;
                            ensure(db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_claims WHERE block_id=?1 AND thread_id=?2)",params![id,candidate.thread_id],|r|r.get::<_,bool>(0)))?,"CANDIDATE_CLAIMED")?;
                        }
                        // Reinterpret immutable saved output against the exact base; compare
                        // semantic payload. Fresh insertion IDs belong only to the artifact.
                        let bytes = self.read_object(
                            &run.result
                                .as_ref()
                                .ok_or(ManuscriptError("RESULT_UNAVAILABLE", None))?
                                .hash,
                        )?;
                        let verified = review::proposal(&bytes, &ctx.base, &ctx.thread.anchor)?;
                        ensure(
                            verified.len() == candidate.after.len()
                                && verified.iter().zip(&candidate.after).all(|(a, b)| {
                                    a.kind == b.kind
                                        && a.attrs == b.attrs
                                        && a.runs == b.runs
                                        && ((ctx.thread.anchor.slot.is_some()
                                            && !ctx.base.blocks.iter().any(|x| x.id == a.id))
                                            || a.id == b.id)
                                }),
                            "CANDIDATE_INVALID",
                        )?;
                        ensure(candidate.before == ctx.base.blocks, "CANDIDATE_INVALID")?;
                        let mut after = None;
                        for block in &candidate.after {
                            if let Some(old) = before.blocks.iter().find(|b| b.id == block.id) {
                                ensure(
                                    ctx.base.blocks.iter().any(|b| b == old),
                                    "PATCH_OUT_OF_SCOPE",
                                )?;
                                if old.runs != block.runs {
                                    operations.push(Primitive::SetBlockContent {
                                        id: old.id.clone(),
                                        runs: block.runs.clone(),
                                    });
                                    revisions.push(BlockRevision {
                                        id: old.id.clone(),
                                        revision: old.revision,
                                    });
                                }
                            } else {
                                ensure(ctx.thread.anchor.slot.is_some(), "PATCH_OUT_OF_SCOPE")?;
                                operations.push(Primitive::InsertBlock {
                                    block: NewBlock {
                                        id: block.id.clone(),
                                        kind: block.kind.clone(),
                                        attrs: block.attrs.clone(),
                                        runs: block.runs.clone(),
                                    },
                                    after: after.clone(),
                                });
                            }
                            after = Some(block.id.clone());
                        }
                        let single = self.apply_review_operations(
                            c,
                            before,
                            command,
                            &operations[operation_start..],
                            &revisions[revision_start..],
                            identities,
                        )?;
                        self.guard_reviews(c, command, before, &single)?;
                        let old = threads
                            .iter_mut()
                            .find(|t| t.id == candidate.thread_id && !t.deleted)
                            .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                        old.handled = true;
                        old.decision = Some(ReviewUserDecision {
                            candidate_id: candidate.id.clone(),
                            decision: ReviewUserDecisionDecision::Accepted,
                        });
                        Ok(())
                    })();
                    if let Err(error) = validation {
                        if error.0 == "STORAGE_UNAVAILABLE" {
                            return Err(error);
                        }
                        first_error.get_or_insert(error.0);
                        conflicts.push(CandidateConflict {
                            id: reference.id.clone(),
                            version: reference.version,
                            reason: error.0.into(),
                            affected_ids: conflict_scope,
                        });
                    }
                }
                if let Some(code) = first_error {
                    return Err(ManuscriptError(
                        code,
                        Some(HistoryErrorDetails {
                            reason: "BATCH_CONFLICT".into(),
                            affected_ids: conflicts
                                .iter()
                                .flat_map(|c| c.affected_ids.clone())
                                .collect(),
                            candidate_conflicts: Some(conflicts),
                        }),
                    ));
                }
                let transition = self.apply_review_operations(
                    c,
                    before,
                    command,
                    &operations,
                    &revisions,
                    identities,
                )?;
                state = transition.state;
                affected = transition.affected;
            }
            _ => return Err(ManuscriptError("INVALID_REQUEST", None)),
        }
        if changed && let ManuscriptCommand::SaveReview { payload, .. } = command {
            let count: i64 = db(c.query_row(
                "SELECT COUNT(*) FROM review_messages WHERE thread_id=?1",
                [&payload.thread.id],
                |r| r.get(0),
            ))?;
            ensure(count < 200, "DOCUMENT_TOO_LARGE")?;
        }
        if changed && state.working_revision == before.working_revision {
            state.working_revision = manuscript::next_revision(before.working_revision)?;
        }
        Ok(Transition {
            locks: None,
            state,
            affected,
            reviews: changed.then_some(threads),
            normalized: false,
            sources: None,
            planning: None,
            planning_metadata: None,
        })
    }
    pub(crate) fn coordinate_reviews(
        &self,
        c: &Connection,
        _command: &ManuscriptCommand,
        before: &ManuscriptState,
        t: &mut Transition,
    ) -> Result<()> {
        if let ManuscriptCommand::RefreshSourceFile { payload, .. } = _command {
            let mut threads = Self::review_threads(c)?;
            let mut changed = false;
            for thread in &mut threads {
                let count = thread.evidence.len();
                thread.evidence.retain(|e| e.source_id != payload.source_id);
                if thread.evidence.len() != count {
                    thread.request_version = manuscript::next_revision(thread.request_version)?;
                    changed = true;
                }
            }
            if changed {
                t.reviews = Some(threads);
            }
        }
        if t.state.blocks != before.blocks
            && !matches!(
                _command,
                ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
            )
        {
            let mut threads = t.reviews.clone().unwrap_or(Self::review_threads(c)?);
            let mut changed = false;
            let structural = before.blocks.iter().map(|b| &b.id).ne(t
                .state
                .blocks
                .iter()
                .map(|b| &b.id));
            let mut mapped = BTreeMap::new();
            for thread in &mut threads {
                if !thread.deleted && !thread.handled {
                    if !thread
                        .anchor
                        .ranges
                        .iter()
                        .any(|r| t.affected.contains(&r.block_id))
                        && !(structural && thread.anchor.ranges.len() > 1)
                        && thread.anchor.slot.is_none()
                    {
                        continue;
                    }
                    let key = db(serde_json::to_string(&thread.anchor))?;
                    let anchor = mapped
                        .entry(key)
                        .or_insert_with(|| review::map_anchor(before, &t.state, &thread.anchor))
                        .clone();
                    changed |= anchor != thread.anchor;
                    thread.anchor = anchor;
                }
            }
            if changed {
                t.reviews = Some(threads);
            }
        }
        Ok(())
    }
    pub(crate) fn commit_reviews(
        &self,
        c: &rusqlite::Transaction,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        t: &Transition,
        prepared: &PreparedReviews,
        history_entry_id: Option<&str>,
    ) -> Result<()> {
        let request = manuscript::envelope(command).0;
        if t.reviews.is_some() {
            for record in &prepared.records {
                let thread = &record.thread;
                let prior = &record.prior;
                if matches!(
                    command,
                    ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
                ) && let Some(prior) = prior
                    && prior.decision != thread.decision
                    && let Some(decision) = &thread.decision
                {
                    // A redo may decide only the exact restored candidate; newer evidence wins a conflict.
                    self.check_candidate_identity(c, &thread.id, &decision.candidate_id)?;
                    self.decide(
                        c,
                        &decision.candidate_id,
                        if decision.decision == ReviewUserDecisionDecision::Accepted {
                            "accepted"
                        } else {
                            "discarded"
                        },
                    )?;
                }
                db(c.execute("INSERT INTO review_threads VALUES(?1,?2,?3,?2,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET high_water=MAX(high_water,excluded.high_water),user_json=excluded.user_json,request_version=excluded.request_version,request_hash=excluded.request_hash,deleted=excluded.deleted,handled=excluded.handled",params![thread.id,thread.request_version,record.json,record.request_hash,thread.deleted,thread.handled]))?;
                if prior.as_ref().is_some_and(|p| {
                    p.request_version != thread.request_version
                        || p.anchor.state != thread.anchor.state
                        || thread.deleted
                }) {
                    db(c.execute("UPDATE review_candidates SET status='stale' WHERE thread_id=?1 AND status='pending'",[&thread.id]))?;
                }
            }
            Self::review_event(c, "review.changed", Some(request))?;
        }
        if let ManuscriptCommand::SaveReview { payload, .. } = command
            && let Some(thread) = t
                .reviews
                .as_ref()
                .and_then(|threads| threads.iter().find(|t| t.id == payload.thread.id))
        {
            db(c.execute("INSERT INTO review_messages(id,thread_id,request_version,author,text,request_user_id) VALUES(?1,?2,?3,'user',?4,?1)",params![request,thread.id,thread.request_version,thread.text]))?;
        }
        // Actual changed dependencies stale candidates while retaining their claim.
        for id in &t.affected {
            db(c.execute("UPDATE review_candidates SET status='stale' WHERE status='pending' AND thread_id IN (SELECT thread_id FROM review_claims WHERE block_id=?1)",[id]))?;
        }
        for record in &prepared.records {
            if let Some((candidate, h, ctx)) = &record.rebound {
                self.check_candidate_identity(c, &record.thread.id, &candidate.id)?;
                if let Some(ctx) = ctx {
                    Self::review_sql_dependencies(c, ctx)
                        .map_err(|_| ManuscriptError("HISTORY_BLOCKED", None))?;
                    db(c.execute("INSERT INTO review_candidate_bindings VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(candidate_id) DO UPDATE SET request_version=excluded.request_version,request_hash=excluded.request_hash,tokens=excluded.tokens,context_hash=excluded.context_hash,history_entry_id=excluded.history_entry_id",params![candidate.id,ctx.thread.request_version,ctx.request_hash,ctx.tokens,h,Self::replay_review_entry(c,command)?]))?;
                    db(c.execute("UPDATE review_candidates SET status='pending',request_version=?2 WHERE id=?1",params![candidate.id,ctx.thread.request_version]))?;
                } else {
                    db(c.execute(
                        "UPDATE review_candidates SET status='stale' WHERE id=?1",
                        [&candidate.id],
                    ))?;
                }
                for id in candidate.before.iter().map(|b| &b.id) {
                    db(c.execute(
                        "INSERT OR IGNORE INTO review_claims VALUES(?1,?2)",
                        params![id, record.thread.id],
                    ))?;
                    db(c.execute("INSERT INTO review_comparisons VALUES(?1,?2,?3,NULL) ON CONFLICT(block_id) DO UPDATE SET thread_id=excluded.thread_id,candidate_id=excluded.candidate_id",params![id,record.thread.id,candidate.id]))?;
                }
            }
        }
        if let ManuscriptCommand::AcceptReviewCandidates { payload, .. } = command {
            for r in &payload.candidates {
                self.decide(c, &r.id, "accepted")?;
            }
            db(c.execute(
                "INSERT INTO review_decisions VALUES(?1,?2,'accepted',?3)",
                params![
                    request,
                    db(serde_json::to_string(&payload.candidates))?,
                    history_entry_id.ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?
                ],
            ))?;
        }
        if let ManuscriptCommand::DiscardReviewCandidate { payload, .. } = command {
            self.decide(c, &payload.candidate.id, "discarded")?;
            db(c.execute(
                "INSERT INTO review_decisions VALUES(?1,?2,'discarded',?3)",
                params![
                    request,
                    db(serde_json::to_string(&payload.candidate))?,
                    history_entry_id.ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?
                ],
            ))?;
        }
        let mut fence_ids = vec![];
        match command {
            ManuscriptCommand::CancelReviewTask { payload, .. } => {
                fence_ids.push(payload.thread_id.clone())
            }
            ManuscriptCommand::DeleteReviewThread { payload, .. } => {
                fence_ids.push(payload.thread_id.clone())
            }
            ManuscriptCommand::SaveReview { payload, .. } if t.reviews.is_some() => {
                fence_ids.push(payload.thread.id.clone())
            }
            _ => {}
        }
        for record in &prepared.records {
            // Refresh preserves running immutable inputs; the changed request version makes
            // their result stale at reconciliation without cancelling or redispatching it.
            if !matches!(command, ManuscriptCommand::RefreshSourceFile { .. })
                && (record.thread.deleted
                    || record
                        .prior
                        .as_ref()
                        .is_some_and(|p| p.request_version != record.thread.request_version))
            {
                fence_ids.push(record.thread.id.clone());
            }
        }
        fence_ids.sort();
        fence_ids.dedup();
        for id in &fence_ids {
            // An instruction edit fences applicability; it does not implicitly
            // start a replacement call or transfer another thread's claim.
            let mut s = db(c.prepare(
                "SELECT run_id FROM review_tasks WHERE thread_id=?1 AND application='pending'",
            ))?;
            let ids = db(s.query_map([id], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?;
            for run_id in ids {
                let mut uow = AiUnitOfWork {
                    tx: c,
                    prepared: None,
                };
                let run = ai(Self::ai_run(c, &run_id))?;
                if ai(ReviewCoordinator.cancel(&mut uow, &run))? {
                    ai(uow.cancel_in_unit_of_work(&run_id))?;
                }
                db(c.execute("UPDATE review_tasks SET application='cancelled',error='CANCELLED' WHERE run_id=?1",[&run_id]))?;
                db(c.execute("DELETE FROM review_reservations WHERE run_id=?1", [&run_id]))?;
            }
            if prepared
                .records
                .iter()
                .any(|r| r.thread.id == *id && r.thread.deleted)
            {
                let mut stmt=db(c.prepare("SELECT id,version FROM review_candidates WHERE thread_id=?1 AND status IN ('pending','stale')"))?;
                let decided = db(stmt.query_map([id], |r| {
                    Ok(ReviewCandidateRef {
                        id: r.get(0)?,
                        version: r.get(1)?,
                    })
                }))?
                .map(db)
                .collect::<Result<Vec<_>>>()?;
                if matches!(
                    command,
                    ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
                ) {
                    for candidate in &decided {
                        db(c.execute("INSERT INTO review_history_evidence VALUES(?1,?2,?3) ON CONFLICT(history_entry_id,thread_id) DO UPDATE SET candidate_id=excluded.candidate_id",params![Self::replay_review_entry(c,command)?,id,candidate.id]))?;
                    }
                }
                if !decided.is_empty()
                    && !matches!(
                        command,
                        ManuscriptCommand::UndoProject { .. }
                            | ManuscriptCommand::RedoProject { .. }
                    )
                {
                    db(c.execute(
                        "INSERT INTO review_decisions VALUES(?1,?2,'deleted',?3)",
                        params![
                            request,
                            db(serde_json::to_string(&decided))?,
                            history_entry_id.ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?
                        ],
                    ))?;
                }
                db(c.execute("UPDATE review_candidates SET status='discarded' WHERE thread_id=?1 AND status IN ('pending','stale')",[id]))?;
                Self::clear_review_candidate_comparisons(c, id)?;
            }
            self.release_claim_without_candidate(c, id)?;
        }
        self.commit_source_comparisons(c, before, t, prepared)?;
        if t.state.blocks != before.blocks {
            Self::review_event(c, "candidate.changed", Some(request))?;
        }
        Ok(())
    }
    fn decide(&self, c: &Connection, id: &str, status: &str) -> Result<()> {
        let thread: String = db(c.query_row(
            "SELECT thread_id FROM review_candidates WHERE id=?1",
            [id],
            |r| r.get(0),
        ))?;
        db(c.execute(
            "UPDATE review_candidates SET status=?2 WHERE id=?1",
            params![id, status],
        ))?;
        db(c.execute("UPDATE review_comparisons SET candidate_id=NULL WHERE candidate_id=?1 AND payload_hash IS NOT NULL",[id]))?;
        db(c.execute("DELETE FROM review_comparisons WHERE candidate_id=?1", [id]))?;
        db(c.execute("DELETE FROM review_claims WHERE thread_id=?1", [thread]))?;
        Self::review_event(c, "candidate.changed", None)
    }
    fn release_claim_without_candidate(&self, c: &Connection, id: &str) -> Result<()> {
        db(c.execute("DELETE FROM review_claims WHERE thread_id=?1 AND block_id NOT IN (SELECT p.block_id FROM review_comparisons p JOIN review_candidates a ON a.id=p.candidate_id WHERE p.thread_id=?1 AND a.status IN ('pending','stale') UNION SELECT r.block_id FROM review_reservations r JOIN review_tasks t ON t.run_id=r.run_id WHERE t.thread_id=?1 AND t.application='pending')",[id]))?;
        Ok(())
    }
    fn review_event(c: &Connection, kind: &str, request: Option<&str>) -> Result<()> {
        db(c.execute(
            "INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,?2,'{}')",
            params![request.unwrap_or(""), kind],
        ))?;
        Ok(())
    }
    pub fn start_review(
        &self,
        settings: &dyn AiSettingsPort,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let result = self.start_review_inner(settings, command);
        if let Err(error) = &result {
            let id = manuscript::envelope(command).0;
            if manuscript::uuid4(id) {
                ai(self.release_ai_preparation(id))?;
                if error.0 != "STORAGE_UNAVAILABLE" && error.0 != "REQUEST_ID_CONFLICT" {
                    let c = db(self.connection.lock())?;
                    if let Some(receipt) = Self::receipt_for(&c, command)? {
                        return Ok(receipt);
                    }
                    db(c.execute(
                        "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                        params![
                            id,
                            hash(&db(serde_json::to_vec(command))?),
                            serde_json::json!({"error":error.0}).to_string()
                        ],
                    ))?;
                }
            }
        }
        result
    }
    fn start_review_inner(
        &self,
        settings: &dyn AiSettingsPort,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let (request, project, expected) = manuscript::envelope(command);
        ensure(
            manuscript::uuid4(request) && manuscript::uuid4(project),
            "INVALID_REQUEST",
        )?;
        {
            let c = db(self.connection.lock())?;
            if let Some(receipt) = Self::receipt_for(&c, command)? {
                return Ok(receipt);
            }
        }
        let ManuscriptCommand::StartReviewTask { payload, .. } = command else {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        };
        ai(self.register_ai_consumer(std::sync::Arc::new(ReviewCoordinator)))?;
        let config =
            ai(settings.resolve_configuration(AiCategory::Text, AiCapability::Textgenerate))?
                .configuration;
        let (mut ctx, visuals) = {
            let c = db(self.connection.lock())?;
            let thread = Self::thread(&c, &payload.thread_id)?;
            ensure(
                !thread.deleted
                    && !thread.handled
                    && thread.request_version == payload.request_version,
                "REVIEW_VERSION_CONFLICT",
            )?;
            ensure(!Self::active(&c, &thread.id)?, "REVIEW_TASK_ACTIVE")?;
            ensure(
                self.load(&c)?.workspace_stage == ManuscriptStateWorkspaceStage::Draft,
                "STAGE_CONFLICT",
            )?;
            if thread.kind == ReviewThreadKind::Question {
                let count: i64 = db(c.query_row(
                    "SELECT COUNT(*) FROM review_messages WHERE thread_id=?1",
                    [&thread.id],
                    |r| r.get(0),
                ))?;
                ensure(count < 200, "DOCUMENT_TOO_LARGE")?;
            }
            self.context(&c, &thread)?
        };
        {
            let c = db(self.connection.lock())?;
            ctx.conversation = Self::chosen_messages(
                &c,
                &ctx.thread.id,
                payload.message_ids.as_deref().unwrap_or(&[]),
            )?;
        }
        if !visuals.is_empty() {
            ensure(
                config.model.capabilities.images.state != AiEvidenceState::Unsupported,
                "CAPABILITY_UNSUPPORTED",
            )?;
            if config.model.capabilities.images.state == AiEvidenceState::Unknown {
                ensure(
                    ctx.thread
                        .evidence
                        .iter()
                        .filter(|e| e.mode == PlanningEvidenceChoiceMode::Visualinput)
                        .all(|e| e.allow_unknown_images),
                    "EVIDENCE_CHOICE_REQUIRED",
                )?;
            }
        }
        let (mut input, artifacts) = scenesparrow_application::review::compose(
            &ctx.thread,
            &ctx.base,
            &ctx.evidence,
            &visuals,
            &ctx.conversation,
        )?;
        for a in &mut input.input_artifacts {
            a.hash = hash(
                artifacts
                    .get(&a.id)
                    .ok_or(ManuscriptError("INVALID_INPUT", None))?,
            );
        }
        ai(scenesparrow_domain::ai::validate_input(&input, &config))?;
        let bytes = input
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .map(|p| match p {
                AiPart::Text { text } => text.len(),
                _ => 0,
            })
            .sum::<usize>();
        if let Some(limit) = config.model.context_tokens {
            ensure(
                (bytes / 3 + visuals.len() * 4096 + 512) as i64 <= limit,
                "CONTEXT_LIMIT",
            )?;
        }
        let input_hash = ai(self.prepare_ai_input(request, &input, &artifacts))?;
        let context_hash = {
            let c = db(self.connection.lock())?;
            let h = self.object(&db(serde_json::to_vec(&ctx))?)?;
            db(c.execute(
                "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
                params![request, h],
            ))?;
            for e in &ctx.evidence {
                if self
                    .directory
                    .join("objects")
                    .join(&e.content_hash)
                    .exists()
                {
                    db(c.execute(
                        "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
                        params![request, e.content_hash],
                    ))?;
                }
            }
            h
        };
        let provenance = {
            let c = db(self.connection.lock())?;
            let sources = Self::source_members(&c)?;
            let mut hashes = BTreeSet::new();
            for e in &ctx.evidence {
                if self
                    .directory
                    .join("objects")
                    .join(&e.content_hash)
                    .exists()
                {
                    self.read_object(&e.content_hash)?;
                    hashes.insert(e.content_hash.clone());
                }
                if let Some(h) = sources
                    .iter()
                    .find(|s| s.id == e.source_id)
                    .and_then(|s| s.object_hash.clone())
                {
                    self.read_object(&h)?;
                    hashes.insert(h);
                }
            }
            hashes
        };
        let operation = if ctx.thread.kind == ReviewThreadKind::Question {
            "question"
        } else if ctx.thread.anchor.slot.is_some() {
            "fill_section"
        } else {
            "replace_ranges"
        };
        let start = AiStart {
            request_id: request.into(),
            run_id: request.into(),
            binding_id: request.into(),
            consumer: "script-review".into(),
            fingerprint: config.fingerprint,
            input_hash,
            retry_of_run_id: payload.retry_of_run_id.clone().flatten(),
        };
        ai(self.accept_ai_module(settings,&start,&mut |c,uow,run|{(||->Result<()>{
            if Self::receipt_for(c,command)?.is_some(){return Ok(());}
            ensure(crate::read_project(c).map_err(|_|ManuscriptError("STORAGE_UNAVAILABLE",None))?.is_some_and(|p|p.id==project),"PROJECT_NOT_FOUND")?;
            let (revision,stage):(i64,String)=db(c.query_row("SELECT working_revision,workspace_stage FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
            ensure(revision==expected,"REVISION_CONFLICT")?;ensure(stage=="draft","STAGE_CONFLICT")?;
            Self::review_sql_dependencies(c,&ctx)?;ensure(!Self::active(c,&ctx.thread.id)?,"REVIEW_TASK_ACTIVE")?;
            if let Some(old)=payload.retry_of_run_id.as_ref().and_then(|v|v.as_ref()){let compatible:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_tasks WHERE run_id=?1 AND thread_id=?2 AND operation=?3 AND application!='pending')",params![old,ctx.thread.id,operation],|r|r.get(0)))?;ensure(compatible,"INVALID_RETRY")?;}
            if ctx.thread.kind==ReviewThreadKind::Revisionnote {
                for id in Self::scope(&ctx.thread){
                    let owner:Option<String>=db(c.query_row("SELECT thread_id FROM review_claims WHERE block_id=?1",[&id],|r|r.get(0)).optional())?;
                    ensure(owner.is_none_or(|owner|owner==ctx.thread.id),"CANDIDATE_CLAIMED")?;
                    db(c.execute("INSERT OR IGNORE INTO review_claims VALUES(?1,?2)",params![id,ctx.thread.id]))?;
                }
            }
            ai(uow.stage_consumer_record("script-review",&run.binding_id,&run.run_id,"{}"))?;
            db(c.execute("INSERT INTO review_tasks(run_id,thread_id,request_version,context_hash,slot_heading,slot_after,operation) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![run.run_id,ctx.thread.id,ctx.thread.request_version,context_hash,ctx.thread.anchor.slot.as_ref().map(|s|&s.heading_id),ctx.thread.anchor.slot.as_ref().and_then(|s|s.after_id.as_ref()),operation]))?;
            if ctx.thread.kind==ReviewThreadKind::Revisionnote {
                for id in Self::scope(&ctx.thread).into_iter().chain(ctx.thread.evidence.iter().map(|e|e.source_id.clone())){db(c.execute("INSERT OR IGNORE INTO review_reservations VALUES(?1,?2)",params![id,run.run_id]))?;}
            }
            db(c.execute("INSERT OR IGNORE INTO external_object_pins SELECT ?1,object_hash FROM external_object_pins WHERE owner_id=?2",params![format!("review:{}",run.run_id),request]))?;
            db(c.execute("INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",params![format!("review:{}",run.run_id),context_hash]))?;
            for h in &provenance {db(c.execute("INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",params![format!("review:{}",run.run_id),h]))?;}
            Self::review_event(c,"reviewTask.changed",Some(request))?;Self::write_receipt(c,command)?;Ok(())
        })().map_err(to_ai)}))?;
        let c = db(self.connection.lock())?;
        Self::receipt_for(&c, command)?.ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))
    }
    pub fn reconcile_reviews(&self) -> Result<()> {
        ai(self.register_ai_consumer(std::sync::Arc::new(ReviewCoordinator)))?;
        let ids = {
            let c = db(self.connection.lock())?;
            let mut s=db(c.prepare("SELECT run_id FROM review_tasks WHERE application='pending' ORDER BY rowid LIMIT 100"))?;
            db(s.query_map([], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        for id in ids {
            let run = ai(self.read_run(&id))?;
            if !scenesparrow_domain::ai::terminal(&run.status) {
                continue;
            }
            let mut c = db(self.connection.lock())?;
            let pending: bool = db(c.query_row(
                "SELECT application='pending' FROM review_tasks WHERE run_id=?1",
                [&id],
                |r| r.get(0),
            ))?;
            if !pending {
                continue;
            }
            let ctx = self.load_context(&c, &id)?;
            let applicability: String = db(c.query_row(
                "SELECT applicability FROM application_execution_bindings WHERE run_id=?1",
                [&id],
                |r| r.get(0),
            ))?;
            let output = (|| -> Result<(Option<String>, Option<ReviewCandidate>)> {
                ensure(
                    run.status == AiRunStatus::Succeeded && applicability == "pending",
                    "CONSUMER_CANCELLED",
                )?;
                self.review_dependencies(&c, &ctx)?;
                let bytes = self.read_object(
                    &run.result
                        .as_ref()
                        .ok_or(ManuscriptError("RESULT_UNAVAILABLE", None))?
                        .hash,
                )?;
                if ctx.thread.kind == ReviewThreadKind::Question {
                    return Ok((Some(review::answer(&bytes, &ctx.evidence)?), None));
                }
                for block in Self::scope(&ctx.thread) {
                    ensure(db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_claims WHERE block_id=?1 AND thread_id=?2)",params![block,ctx.thread.id],|r|r.get::<_,bool>(0)))?,"CANDIDATE_CLAIMED")?;
                }
                let after = review::proposal(&bytes, &ctx.base, &ctx.thread.anchor)?;
                if after == ctx.base.blocks {
                    return Err(ManuscriptError("NO_CHANGE", None));
                }
                Ok((
                    None,
                    Some(ReviewCandidate {
                        id: uuid::Uuid::new_v4().to_string(),
                        version: 1,
                        thread_id: ctx.thread.id.clone(),
                        request_version: ctx.thread.request_version,
                        run_id: id.clone(),
                        status: "pending".into(),
                        explanation: review::explanation(&bytes)?,
                        preview_truncated: false,
                        detail_next_cursor: None,
                        before: ctx.base.blocks.clone(),
                        after,
                    }),
                ))
            })();
            let candidate_hash = match &output {
                Ok((_, Some(candidate))) => Some(self.object(&db(serde_json::to_vec(candidate))?)?),
                _ => None,
            };
            let tx = db(c.transaction())?;
            match output {
                Ok((answer, candidate)) => {
                    if let Some(candidate) = candidate {
                        db(tx.execute("UPDATE review_candidates SET status='superseded' WHERE thread_id=?1 AND status IN ('pending','stale')",[&ctx.thread.id]))?;
                        Self::clear_review_candidate_comparisons(&tx, &ctx.thread.id)?;
                        db(tx.execute(
                            "INSERT INTO review_candidates VALUES(?1,1,?2,?3,?4,?5,'pending')",
                            params![
                                candidate.id,
                                ctx.thread.id,
                                ctx.thread.request_version,
                                id,
                                candidate_hash
                            ],
                        ))?;
                        for block in Self::scope(&ctx.thread) {
                            db(tx.execute(
                                "INSERT INTO review_comparisons VALUES(?1,?2,?3,NULL) ON CONFLICT(block_id) DO UPDATE SET thread_id=excluded.thread_id,candidate_id=excluded.candidate_id",
                                params![block, ctx.thread.id, candidate.id],
                            ))?;
                        }
                    }
                    if let Some(text) = &answer {
                        db(tx.execute("INSERT OR IGNORE INTO review_messages(id,thread_id,request_version,author,text,request_user_id) VALUES(?1,?2,?3,'ai',?4,?5)",params![id,ctx.thread.id,ctx.thread.request_version,text,ctx.thread.user_message_ids.last().ok_or(ManuscriptError("REVIEW_VERSION_CONFLICT",None))?]))?;
                    }
                    db(tx.execute("UPDATE review_tasks SET application='applied',answer=?2,error=NULL WHERE run_id=?1",params![id,answer]))?;
                    db(tx.execute("UPDATE application_execution_bindings SET applicability='applied' WHERE run_id=?1 AND applicability='pending'",[&id]))?;
                }
                Err(e) => {
                    db(tx.execute(
                        "UPDATE review_tasks SET application=?2,error=?3 WHERE run_id=?1",
                        params![
                            id,
                            if e.0 == "NO_CHANGE" {
                                "no_change"
                            } else {
                                "not_applied"
                            },
                            run.error.as_deref().unwrap_or(e.0)
                        ],
                    ))?;
                    db(tx.execute("UPDATE application_execution_bindings SET applicability='cancelled' WHERE run_id=?1 AND applicability='pending'",[&id]))?;
                }
            }
            db(tx.execute("DELETE FROM review_reservations WHERE run_id=?1", [&id]))?;
            self.release_claim_without_candidate(&tx, &ctx.thread.id)?;
            Self::review_event(&tx, "reviewTask.changed", Some(&id))?;
            Self::review_event(&tx, "candidate.changed", Some(&id))?;
            db(tx.commit())?;
        }
        Ok(())
    }
}
impl SqliteProjectRepository {
    pub(crate) fn restore_reviews(
        &self,
        c: &Connection,
        t: &mut Transition,
        target: &manuscript::BusinessSnapshot,
    ) -> Result<()> {
        let current = Self::review_threads(c)?;
        if review::snapshot(&current) == target.reviews {
            return Ok(());
        }
        let mut restored = target.reviews.clone();
        for thread in &mut restored {
            let previous = current.iter().find(|t| t.id == thread.id);
            if let Some(old) = previous.filter(|old| {
                let mut status_only = (*old).clone();
                status_only.handled = thread.handled;
                !old.deleted && review::snapshot(&[status_only]) == vec![thread.clone()]
            }) {
                thread.request_version = old.request_version;
            } else {
                let high: Option<i64> = db(c
                    .query_row(
                        "SELECT high_water FROM review_threads WHERE id=?1",
                        [&thread.id],
                        |r| r.get(0),
                    )
                    .optional())?;
                if !thread.deleted {
                    ensure(!Self::active(c, &thread.id)?, "HISTORY_BLOCKED")?;
                }
                if let Some(candidate) = self.current_candidate(c, &thread.id)? {
                    ensure(
                        previous
                            .and_then(|t| t.decision.as_ref())
                            .is_some_and(|d| d.candidate_id == candidate.id)
                            || thread
                                .decision
                                .as_ref()
                                .is_some_and(|d| d.candidate_id == candidate.id)
                            || previous.is_some_and(|t| t.decision == thread.decision),
                        "HISTORY_BLOCKED",
                    )?;
                }
                thread.request_version = manuscript::next_revision(high.unwrap_or(0))?;
            }
            for range in &mut thread.anchor.ranges {
                if let Some(block) = t.state.blocks.iter().find(|b| b.id == range.block_id) {
                    range.revision = block.revision;
                } else {
                    thread.anchor.state = "orphaned".into();
                }
            }
        }
        for old in current {
            if !restored.iter().any(|t| t.id == old.id) {
                if old.deleted {
                    restored.push(old);
                    continue;
                }

                let mut old = old;
                old.deleted = true;
                old.request_version = manuscript::next_revision(old.request_version)?;
                restored.push(old);
            }
        }
        restored.sort_by(|a, b| a.id.cmp(&b.id));
        t.reviews = Some(restored);
        Ok(())
    }
}
#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;
impl SqliteProjectRepository {
    pub(crate) fn prepare_reviews(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        t: &Transition,
    ) -> Result<PreparedReviews> {
        let old = Self::review_threads(c)?;
        let threads = t.reviews.clone().unwrap_or_else(|| old.clone());
        let mut records = vec![];
        let mut pairs = BTreeMap::new();
        if t.reviews.is_some() {
            for thread in &threads {
                let prior = old.iter().find(|p| p.id == thread.id).cloned();
                if prior.as_ref() == Some(thread) {
                    continue;
                }
                let replay = matches!(
                    command,
                    ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
                );
                let entry = if replay {
                    Some(Self::replay_review_entry(c, command)?)
                } else {
                    None
                };
                let restore_id = if replay && !thread.deleted {
                    if prior
                        .as_ref()
                        .is_some_and(|p| p.decision != thread.decision)
                    {
                        prior
                            .as_ref()
                            .and_then(|p| p.decision.as_ref())
                            .map(|d| d.candidate_id.clone())
                    } else if prior.as_ref().is_some_and(|p| p.deleted) {
                        let json:Option<String>=db(c.query_row("SELECT candidate_ids_json FROM review_decisions WHERE history_entry_id=?1 AND decision='deleted'",[entry.as_ref().unwrap()],|r|r.get(0)).optional())?;
                        json.map(|j| db(serde_json::from_str::<Vec<ReviewCandidateRef>>(&j)))
                            .transpose()?
                            .and_then(|v| v.first().map(|r| r.id.clone()))
                    } else {
                        None
                    }
                } else {
                    None
                };
                let restore_id = if restore_id.is_none()
                    && replay
                    && !thread.deleted
                    && prior.as_ref().is_some_and(|p| p.deleted)
                {
                    db(c.query_row("SELECT candidate_id FROM review_history_evidence WHERE history_entry_id=?1 AND thread_id=?2",params![entry.as_ref().unwrap(),thread.id],|r|r.get(0)).optional())?
                } else {
                    restore_id
                };
                let rebound = restore_id
                    .map(|id| {
                        self.prepare_candidate_rebind(
                            c,
                            &id,
                            thread,
                            &t.state,
                            entry.as_ref().unwrap(),
                        )
                    })
                    .transpose()?;
                records.push(PreparedReviewRecord {
                    thread: thread.clone(),
                    prior,
                    json: db(serde_json::to_string(&Self::stored_review_thread(thread)))?,
                    request_hash: Self::request_hash(thread)?,
                    rebound,
                });
            }
        }
        for old in &before.blocks {
            if t.affected.contains(&old.id)
                && threads.iter().any(|thread| {
                    !thread.deleted
                        && !thread.handled
                        && thread.anchor.ranges.iter().any(|r| r.block_id == old.id)
                })
            {
                let pair = ReviewComparison {
                    preview_truncated: false,
                    block_id: old.id.clone(),
                    before: old.clone(),
                    after: t.state.blocks.iter().find(|b| b.id == old.id).cloned(),
                };
                pairs.insert(
                    old.id.clone(),
                    self.object(&db(serde_json::to_vec(&pair))?)?,
                );
            }
        }
        Ok(PreparedReviews {
            records,
            threads,
            pairs,
        })
    }
    fn commit_source_comparisons(
        &self,
        c: &Connection,
        before: &ManuscriptState,
        t: &Transition,
        prepared: &PreparedReviews,
    ) -> Result<()> {
        let threads = &prepared.threads;
        let mut stmt =
            db(c.prepare("SELECT block_id FROM review_comparisons WHERE candidate_id IS NULL"))?;
        let old_ids = db(stmt.query_map([], |r| r.get::<_, String>(0)))?
            .map(db)
            .collect::<Result<Vec<_>>>()?;
        for id in old_ids {
            if !threads.iter().any(|t| {
                !t.deleted && !t.handled && t.anchor.ranges.iter().any(|r| r.block_id == id)
            }) {
                db(c.execute(
                    "DELETE FROM review_comparisons WHERE block_id=?1 AND candidate_id IS NULL",
                    [id],
                ))?;
            }
        }
        for old in &before.blocks {
            if !t.affected.contains(&old.id) {
                continue;
            }
            if let Some(owner) = threads.iter().find(|thread| {
                !thread.deleted
                    && !thread.handled
                    && thread.anchor.ranges.iter().any(|r| r.block_id == old.id)
            }) {
                let occupied:bool=db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_comparisons WHERE block_id=?1 AND candidate_id IS NOT NULL)",[&old.id],|r|r.get(0)))?;
                if occupied {
                    if let Some(h) = prepared.pairs.get(&old.id) {
                        db(c.execute(
                            "UPDATE review_comparisons SET payload_hash=?2 WHERE block_id=?1",
                            params![old.id, h],
                        ))?;
                    }
                    continue;
                }
                let h = prepared
                    .pairs
                    .get(&old.id)
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                db(c.execute(
                    "INSERT OR REPLACE INTO review_comparisons VALUES(?1,?2,NULL,?3)",
                    params![old.id, owner.id, h],
                ))?;
            }
        }
        Ok(())
    }
}

impl SqliteProjectRepository {
    fn request_hash(thread: &ReviewThread) -> Result<String> {
        let thread = Self::stored_review_thread(thread);
        Ok(hash(&db(serde_json::to_vec(&(
            &thread.kind,
            &thread.text,
            &thread.anchor,
            &thread.language,
            &thread.evidence,
        )))?))
    }
    fn review_tokens(c: &Connection, thread: &ReviewThread) -> Result<String> {
        Self::review_tokens_for(c, thread, None)
    }
    fn review_tokens_for(
        c: &Connection,
        thread: &ReviewThread,
        state: Option<&ManuscriptState>,
    ) -> Result<String> {
        let mut tokens = vec![];
        for id in Self::scope(thread) {
            let token: Option<(i64, String)> = db(c
                .query_row(
                    "SELECT revision,payload_hash FROM blocks WHERE id=?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            let token = if let Some(state) = state {
                state
                    .blocks
                    .iter()
                    .find(|b| b.id == id)
                    .map(|b| Ok((b.revision, hash(&db(serde_json::to_vec(b))?))))
                    .transpose()?
            } else {
                token
            };
            tokens.push(serde_json::json!([id, token]));
        }
        for pair in thread.anchor.ranges.windows(2) {
            let next:Option<String>=db(c.query_row("SELECT id FROM blocks WHERE position=(SELECT position+1 FROM blocks WHERE id=?1)",[&pair[0].block_id],|r|r.get(0)).optional())?;
            let next = if let Some(state) = state {
                state
                    .blocks
                    .iter()
                    .position(|b| b.id == pair[0].block_id)
                    .and_then(|i| state.blocks.get(i + 1))
                    .map(|b| b.id.clone())
            } else {
                next
            };
            tokens.push(serde_json::json!([
                "range-adjacency",
                pair[0].block_id,
                next
            ]));
        }
        if let Some(slot) = &thread.anchor.slot {
            let next:Option<String>=db(c.query_row("SELECT id FROM blocks WHERE position=(SELECT position+1 FROM blocks WHERE id=?1)",[&slot.heading_id],|r|r.get(0)).optional())?;
            let next = if let Some(state) = state {
                state
                    .blocks
                    .iter()
                    .position(|b| b.id == slot.heading_id)
                    .and_then(|i| state.blocks.get(i + 1))
                    .map(|b| b.id.clone())
            } else {
                next
            };
            tokens.push(serde_json::json!(["slot", next]));
        }
        for e in &thread.evidence {
            let source: Option<(i64, String)> = db(c
                .query_row(
                    "SELECT revision,payload_json FROM sources WHERE id=?1",
                    [&e.source_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            let result: Option<String> = if matches!(
                e.mode,
                PlanningEvidenceChoiceMode::Extractedtext | PlanningEvidenceChoiceMode::Textonly
            ) {
                Self::current_source_extraction(c, &e.source_id)?
            } else {
                None
            };
            let visual: Option<(String, Option<String>, i64)> =
                if e.mode == PlanningEvidenceChoiceMode::Visualinput {
                    db(c.query_row(
                    "SELECT status,object_hash,source_revision FROM planning_visuals WHERE id=?1",
                    [&e.visual_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional())?
                } else {
                    None
                };
            tokens.push(serde_json::json!([e.source_id, source, result, visual]));
        }
        Ok(hash(&db(serde_json::to_vec(&tokens))?))
    }
    fn review_sql_dependencies(c: &Connection, ctx: &Context) -> Result<()> {
        let (version, request_hash, deleted): (i64, String, bool) = db(c
            .query_row(
                "SELECT request_version,request_hash,deleted FROM review_threads WHERE id=?1",
                [&ctx.thread.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional())?
        .ok_or(ManuscriptError("REVIEW_VERSION_CONFLICT", None))?;
        ensure(
            !deleted && version == ctx.thread.request_version && request_hash == ctx.request_hash,
            "REVIEW_VERSION_CONFLICT",
        )?;
        ensure(
            Self::review_tokens(c, &ctx.thread)? == ctx.tokens,
            "CANDIDATE_STALE",
        )
    }
    pub(crate) fn review_acceptance_checks(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
    ) -> Result<Vec<(ReviewCandidate, Context)>> {
        if let ManuscriptCommand::AcceptReviewCandidates { payload, .. } = command {
            payload
                .candidates
                .iter()
                .map(|r| {
                    let candidate = self.candidate_at(c, &r.id)?;
                    let ctx = self.candidate_context(c, &candidate)?;
                    Ok((candidate, ctx))
                })
                .collect()
        } else {
            Ok(vec![])
        }
    }
    pub(crate) fn recheck_review_acceptance(
        c: &Connection,
        checks: &[(ReviewCandidate, Context)],
    ) -> Result<()> {
        for (candidate, ctx) in checks {
            let current:Option<(i64,String,String,i64)>=db(c.query_row("SELECT version,status,run_id,request_version FROM review_candidates WHERE id=?1",[&candidate.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?;
            ensure(
                current
                    == Some((
                        candidate.version,
                        "pending".into(),
                        candidate.run_id.clone(),
                        candidate.request_version,
                    )),
                "CANDIDATE_STALE",
            )?;
            Self::review_sql_dependencies(c, ctx)?;
            ensure(
                !Self::active(c, &candidate.thread_id)?,
                "REVIEW_TASK_ACTIVE",
            )?;
            for block in Self::scope(&ctx.thread) {
                ensure(db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_claims WHERE block_id=?1 AND thread_id=?2)",params![block,candidate.thread_id],|r|r.get::<_,bool>(0)))?,"CANDIDATE_CLAIMED")?;
            }
            ensure(db(c.query_row("SELECT EXISTS(SELECT 1 FROM review_tasks t JOIN ai_runs r ON r.run_id=t.run_id WHERE t.run_id=?1 AND t.application='applied' AND r.status='succeeded')",[&candidate.run_id],|r|r.get::<_,bool>(0)))?,"CANDIDATE_STALE")?;
        }
        Ok(())
    }
    pub(crate) fn review_cancels_execution(
        c: &Connection,
        command: &ManuscriptCommand,
        t: &Transition,
    ) -> Result<bool> {
        if matches!(
            command,
            ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
        ) && let Some(threads) = &t.reviews
        {
            for thread in threads {
                if Self::active(c, &thread.id)?
                    && (thread.deleted
                        || Self::thread(c, &thread.id)?.request_version != thread.request_version)
                {
                    return Ok(true);
                }
            }
        }
        let id = match command {
            ManuscriptCommand::CancelReviewTask { payload, .. } => Some(&payload.thread_id),
            ManuscriptCommand::DeleteReviewThread { payload, .. } => Some(&payload.thread_id),
            ManuscriptCommand::SaveReview { payload, .. } if t.reviews.is_some() => {
                Some(&payload.thread.id)
            }
            _ => None,
        };
        id.map(|id| Self::active(c, id))
            .transpose()
            .map(|v| v.unwrap_or(false))
    }
}
impl SqliteProjectRepository {
    pub fn review_messages(&self, id: &str, before: Option<i64>) -> Result<ReviewMessagePage> {
        ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        let c = db(self.connection.lock())?;
        let thread = Self::thread(&c, id)?;
        ensure(!thread.deleted, "OBJECT_NOT_FOUND")?;
        let rows = Self::messages_at(&c, id)?;
        let mut messages = rows
            .into_iter()
            .filter(|m| {
                m.sequence < before.unwrap_or(i64::MAX)
                    && thread.user_message_ids.contains(&m.request_user_id)
            })
            .take(21)
            .collect::<Vec<_>>();
        let next_cursor = if messages.len() > 20 {
            messages.pop();
            messages.last().map(|m| m.sequence)
        } else {
            None
        };
        messages.reverse();
        Ok(ReviewMessagePage {
            messages,
            next_cursor,
        })
    }
    fn messages_at(c: &Connection, id: &str) -> Result<Vec<ReviewMessage>> {
        let mut stmt=db(c.prepare("SELECT id,sequence,request_version,author,text,request_user_id FROM review_messages WHERE thread_id=?1 ORDER BY sequence DESC LIMIT 201"))?;
        db(stmt.query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        }))?
        .map(|row| {
            let (id, sequence, request_version, author, text, request_user_id) = db(row)?;
            Ok(ReviewMessage {
                id,
                sequence,
                request_version,
                author: if author == "user" {
                    ReviewMessageAuthor::User
                } else {
                    ReviewMessageAuthor::Ai
                },
                text,
                request_user_id,
            })
        })
        .collect()
    }
    fn chosen_messages(c: &Connection, thread: &str, ids: &[String]) -> Result<Vec<ReviewMessage>> {
        ensure(
            ids.len() <= 20 && ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
            "INPUT_TOO_LARGE",
        )?;
        let current = Self::thread(c, thread)?;
        let all = Self::messages_at(c, thread)?;
        let mut out = vec![];
        let mut bytes = 0;
        for id in ids {
            let m = all
                .iter()
                .find(|m| &m.id == id && current.user_message_ids.contains(&m.request_user_id))
                .ok_or(ManuscriptError("REVIEW_VERSION_CONFLICT", None))?;
            bytes += m.text.len();
            ensure(bytes <= 65536, "INPUT_TOO_LARGE")?;
            out.push(m.clone());
        }
        out.sort_by_key(|m| m.sequence);
        Ok(out)
    }
}

impl SqliteProjectRepository {
    fn candidate_summary(mut c: ReviewCandidate) -> ReviewCandidate {
        let mut remaining = 16384;
        for block in c.before.iter_mut().chain(c.after.iter_mut()) {
            let text = review::text(block);
            let preview = text.chars().take(remaining).collect::<String>();
            remaining = remaining.saturating_sub(preview.chars().count());
            if preview != text {
                c.preview_truncated = true;
            }
            block.runs = if preview.is_empty() {
                vec![]
            } else {
                vec![TextRun {
                    text: preview,
                    marks: vec![],
                }]
            };
        }
        if c.preview_truncated {
            c.detail_next_cursor = Some(0);
        }
        c
    }
    pub fn review_candidate(&self, id: &str, offset: usize) -> Result<ReviewCandidate> {
        ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        let c = db(self.connection.lock())?;
        let mut candidate = self.candidate_at(&c, id)?;
        let before_len = candidate.before.len();
        let total = before_len + candidate.after.len();
        ensure(offset < total, "INVALID_REQUEST")?;
        let mut before = vec![];
        let mut after = vec![];
        let mut bytes = 0;
        let mut next = None;
        for (index, block) in candidate
            .before
            .iter()
            .chain(&candidate.after)
            .enumerate()
            .skip(offset)
        {
            let size = db(serde_json::to_vec(block))?.len();
            if bytes + size > 1024 * 1024 && bytes > 0 {
                next = Some(index as i64);
                break;
            }
            ensure(size <= 4 * 1024 * 1024, "INPUT_TOO_LARGE")?;
            bytes += size;
            if index < before_len {
                before.push(block.clone());
            } else {
                after.push(block.clone());
            }
        }
        candidate.before = before;
        candidate.after = after;
        candidate.detail_next_cursor = next;
        candidate.preview_truncated = offset > 0 || next.is_some();
        Ok(candidate)
    }
    fn source_summary(mut pair: ReviewComparison) -> ReviewComparison {
        for block in std::iter::once(&mut pair.before).chain(pair.after.iter_mut()) {
            let text = review::text(block);
            let short = text.chars().take(8192).collect::<String>();
            if short != text {
                pair.preview_truncated = true;
            }
            block.runs = vec![TextRun {
                text: short,
                marks: vec![],
            }];
        }
        pair
    }
    pub fn review_source_comparison(&self, id: &str) -> Result<ReviewComparison> {
        ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        let c = db(self.connection.lock())?;
        let h:Option<String>=db(c.query_row("SELECT payload_hash FROM review_comparisons WHERE block_id=?1 AND candidate_id IS NULL",[id],|r|r.get(0)).optional())?.flatten();
        db(serde_json::from_slice(&self.read_object(
            &h.ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?,
        )?))
    }
}
impl SqliteProjectRepository {
    pub fn prune_review_payloads(&self) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        let threads = Self::review_threads(&c)?;
        let mut live_threads = BTreeSet::new();
        let mut candidate_ids = BTreeSet::new();
        for t in &threads {
            if !t.deleted {
                live_threads.insert(t.id.clone());
                if let Some(d) = &t.decision {
                    candidate_ids.insert(d.candidate_id.clone());
                }
            }
        }
        let mut stmt = db(c.prepare(
            "SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries",
        ))?;
        let roots = db(stmt.query_map([], |r| r.get::<_, String>(0)))?
            .map(db)
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        for h in roots {
            for t in self.read_business(&h)?.reviews {
                live_threads.insert(t.id);
                if let Some(d) = t.decision {
                    candidate_ids.insert(d.candidate_id);
                }
            }
        }
        let mut linked=db(c.prepare("SELECT e.candidate_id FROM review_history_evidence e JOIN history_entry_identities h ON h.entry_id=e.history_entry_id"))?;
        for row in db(linked.query_map([], |r| r.get::<_, String>(0)))? {
            candidate_ids.insert(db(row)?);
        }
        drop(linked);
        // Actual retained entry identities include cursor/redo branches. Content
        // hashes or chronological decisions cannot establish history membership.
        let mut decisions = db(c.prepare(
            "SELECT d.candidate_ids_json FROM review_decisions d JOIN history_entry_identities h ON h.entry_id=d.history_entry_id",
        ))?;
        for row in db(decisions.query_map([], |r| r.get::<_, String>(0)))? {
            let value: serde_json::Value = db(serde_json::from_str(&db(row)?))?;
            let entries = if let Some(list) = value.as_array() {
                list.clone()
            } else {
                vec![value]
            };
            for entry in entries {
                if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                    candidate_ids.insert(id.to_owned());
                }
            }
        }
        drop(decisions);
        let mut stmt = db(c.prepare("SELECT id,run_id,status FROM review_candidates"))?;
        let candidates = db(stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }))?
        .map(db)
        .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        let mut keep_runs = BTreeSet::new();
        let mut dead_candidates = vec![];
        for (id, run, status) in candidates {
            if candidate_ids.contains(&id) || matches!(status.as_str(), "pending" | "stale") {
                keep_runs.insert(run);
            } else {
                dead_candidates.push(id);
            }
        }
        let mut stmt = db(
            c.prepare("SELECT run_id,thread_id,application FROM review_tasks ORDER BY rowid DESC")
        )?;
        let tasks = db(stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        }))?
        .map(db)
        .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        for thread in &live_threads {
            for message in Self::messages_at(&c, thread)? {
                if message.author == ReviewMessageAuthor::Ai && !message.text.is_empty() {
                    keep_runs.insert(message.id);
                }
            }
        }
        let mut latest = BTreeSet::new();
        let mut retire = vec![];
        for (run, thread, application) in tasks {
            if application == "pending" || (live_threads.contains(&thread) && latest.insert(thread))
            {
                keep_runs.insert(run.clone());
            }
            if !keep_runs.contains(&run) {
                retire.push(run);
            }
        }
        let tx = db(c.transaction())?;
        for id in dead_candidates {
            db(tx.execute(
                "UPDATE review_candidates SET payload_hash=NULL WHERE id=?1",
                [id],
            ))?;
        }
        for run in retire {
            db(tx.execute("UPDATE review_tasks SET context_hash='',answer=NULL,application=CASE WHEN application='applied' THEN application ELSE 'pruned' END WHERE run_id=?1",[&run]))?;
            db(tx.execute(
                "DELETE FROM external_object_pins WHERE owner_id IN (?1,?2)",
                params![run, format!("review:{run}")],
            ))?;
            db(tx.execute("DELETE FROM ai_artifacts WHERE run_id=?1", [&run]))?;
            db(tx.execute("UPDATE ai_input_snapshots SET payload_retained=0 WHERE input_hash=(SELECT input_hash FROM ai_runs WHERE run_id=?1) AND NOT EXISTS(SELECT 1 FROM ai_runs WHERE input_hash=ai_input_snapshots.input_hash AND status IN ('queued','running','cancelling'))",[&run]))?;
        }
        for mut thread in threads {
            if !live_threads.contains(&thread.id) {
                thread.text.clear();
                thread.anchor.ranges.clear();
                thread.anchor.slot = None;
                thread.evidence.clear();
                thread.decision = None;
                thread.user_message_ids.clear();
                db(tx.execute(
                    "UPDATE review_threads SET user_json=?2 WHERE id=?1",
                    params![thread.id, db(serde_json::to_string(&thread))?],
                ))?;
                db(tx.execute(
                    "UPDATE review_messages SET text='' WHERE thread_id=?1",
                    [thread.id],
                ))?;
            }
        }
        db(tx.commit())?;
        Ok(())
    }
}
impl SqliteProjectRepository {
    fn apply_review_operations(
        &self,
        c: &Connection,
        before: &ManuscriptState,
        command: &ManuscriptCommand,
        operations: &[Primitive],
        revisions: &[BlockRevision],
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        let synthetic: ManuscriptCommand = db(serde_json::from_value(
            serde_json::json!({"type":"ApplyDocumentEdit","requestId":manuscript::envelope(command).0,"projectId":manuscript::envelope(command).1,"expectedWorkingRevision":before.working_revision,"payload":{"operations":operations,"expectedBlockRevisions":revisions,"group":{"groupId":uuid::Uuid::new_v4().to_string(),"clientSessionId":uuid::Uuid::new_v4().to_string(),"groupSequence":1,"kind":"discrete"}}}),
        ))?;
        let mut available = identities.clone();
        let mut resurrected = BTreeMap::new();
        let inserted = operations
            .iter()
            .filter_map(|op| {
                if let Primitive::InsertBlock { block, .. } = op {
                    Some(block.id.as_str())
                } else {
                    None
                }
            })
            .collect::<BTreeSet<_>>();
        if !inserted.is_empty()
            && let ManuscriptCommand::AcceptReviewCandidates { payload, .. } = command
        {
            for reference in &payload.candidates {
                let bound: bool = db(c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM review_candidate_bindings WHERE candidate_id=?1)",
                    [&reference.id],
                    |r| r.get(0),
                ))?;
                if !bound {
                    continue;
                }
                let candidate = self.candidate_at(c, &reference.id)?;
                for block in &candidate.after {
                    if inserted.contains(block.id.as_str())
                        && !candidate.before.iter().any(|b| b.id == block.id)
                        && let Some(high) = identities.get(&block.id)
                    {
                        let tombstoned: bool = db(c.query_row(
                            "SELECT tombstoned FROM object_identities WHERE id=?1",
                            [&block.id],
                            |r| r.get(0),
                        ))?;
                        ensure(tombstoned, "CANDIDATE_INVALID")?;
                        available.remove(&block.id);
                        resurrected.insert(block.id.clone(), manuscript::next_revision(*high)?);
                    }
                }
            }
        }
        let mut transition =
            manuscript::apply(before, &synthetic, &available, self.policy.as_ref())?;
        for block in &mut transition.state.blocks {
            if let Some(revision) = resurrected.get(&block.id) {
                block.revision = *revision;
            }
        }
        manuscript::normalize(&mut transition.state)?;
        Ok(transition)
    }
}
impl SqliteProjectRepository {
    fn prepare_review_thread_quotes(&self, thread: &mut ReviewThread) -> Result<()> {
        for range in &mut thread.anchor.ranges {
            if range.quote.len() > 1024 {
                range.quote_hash = Some(self.object(range.quote.as_bytes())?);
            } else {
                range.quote_hash = None;
            }
        }
        Ok(())
    }
    fn stored_review_thread(thread: &ReviewThread) -> ReviewThread {
        let mut t = thread.clone();
        for range in &mut t.anchor.ranges {
            if range.quote_hash.is_some() {
                range.quote.clear();
            }
        }
        t
    }
    fn hydrate_review_thread(&self, thread: &mut ReviewThread) -> Result<()> {
        let mut cache = BTreeMap::new();
        for range in &mut thread.anchor.ranges {
            if let Some(hash) = &range.quote_hash
                && range.quote.is_empty()
            {
                if !cache.contains_key(hash) {
                    let bytes = self.read_object(hash)?;
                    let text = String::from_utf8(bytes)
                        .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                    cache.insert(hash.clone(), text);
                }
                range.quote = cache[hash].clone();
            }
        }
        Ok(())
    }
}
impl SqliteProjectRepository {
    pub(crate) fn review_acceptance_error(
        checks: &[(ReviewCandidate, Context)],
        code: &str,
    ) -> HistoryErrorDetails {
        let candidate_conflicts = checks
            .iter()
            .map(|(candidate, ctx)| CandidateConflict {
                id: candidate.id.clone(),
                version: candidate.version,
                reason: code.into(),
                affected_ids: Self::scope(&ctx.thread).into_iter().collect(),
            })
            .collect::<Vec<_>>();
        HistoryErrorDetails {
            reason: "BATCH_CONFLICT".into(),
            affected_ids: candidate_conflicts
                .iter()
                .flat_map(|c| c.affected_ids.clone())
                .collect(),
            candidate_conflicts: Some(candidate_conflicts),
        }
    }
}
impl SqliteProjectRepository {
    fn clear_review_candidate_comparisons(c: &Connection, id: &str) -> Result<()> {
        db(c.execute("UPDATE review_comparisons SET candidate_id=NULL WHERE thread_id=?1 AND candidate_id IS NOT NULL AND payload_hash IS NOT NULL",[id]))?;
        db(c.execute(
            "DELETE FROM review_comparisons WHERE thread_id=?1 AND candidate_id IS NOT NULL",
            [id],
        ))?;
        Ok(())
    }
}
impl SqliteProjectRepository {
    fn replay_review_entry(c: &Connection, command: &ManuscriptCommand) -> Result<String> {
        let h = Self::history_metadata(c)?;
        let position =
            h.cursor + i64::from(matches!(command, ManuscriptCommand::RedoProject { .. }));
        db(c.query_row(
            "SELECT entry_id FROM history_entry_identities WHERE position=?1",
            [position],
            |r| r.get(0),
        ))
    }
    fn check_candidate_identity(
        &self,
        c: &Connection,
        thread: &str,
        candidate: &str,
    ) -> Result<()> {
        let mut q = db(c.prepare(
            "SELECT id FROM review_candidates WHERE thread_id=?1 AND status IN ('pending','stale')",
        ))?;
        for row in db(q.query_map([thread], |r| r.get::<_, String>(0)))? {
            ensure(db(row)? == candidate, "HISTORY_BLOCKED")?;
        }
        Ok(())
    }
    fn candidate_context(&self, c: &Connection, candidate: &ReviewCandidate) -> Result<Context> {
        let h: Option<String> = db(c
            .query_row(
                "SELECT context_hash FROM review_candidate_bindings WHERE candidate_id=?1",
                [&candidate.id],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(h) = h {
            db(serde_json::from_slice(&self.read_object(&h)?))
        } else {
            self.load_context(c, &candidate.run_id)
        }
    }
    fn prepare_candidate_rebind(
        &self,
        c: &Connection,
        id: &str,
        thread: &ReviewThread,
        state: &ManuscriptState,
        entry: &str,
    ) -> Result<(ReviewCandidate, String, Option<Context>)> {
        ensure(!Self::active(c, &thread.id)?, "HISTORY_BLOCKED")?;
        self.check_candidate_identity(c, &thread.id, id)?;
        let candidate = self.candidate_at(c, id)?;
        let original = self.load_context(c, &candidate.run_id)?;
        let ids = Self::scope(&original.thread);
        for id in &ids {
            let owner: Option<String> = db(c
                .query_row(
                    "SELECT thread_id FROM review_claims WHERE block_id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional())?;
            ensure(
                owner.is_none_or(|owner| owner == thread.id),
                "HISTORY_BLOCKED",
            )?;
            let occupied:Option<String>=db(c.query_row("SELECT candidate_id FROM review_comparisons WHERE block_id=?1 AND candidate_id IS NOT NULL",[id],|r|r.get(0)).optional())?;
            ensure(
                occupied.is_none_or(|other| other == candidate.id),
                "HISTORY_BLOCKED",
            )?;
            let using: bool = db(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM review_reservations WHERE block_id=?1)",
                [id],
                |r| r.get(0),
            ))?;
            ensure(!using, "HISTORY_BLOCKED")?;
        }
        let validate = (|| -> Result<Context> {
            let mut fresh = thread.clone();
            self.hydrate_review_thread(&mut fresh)?;
            let mut request = original.thread.clone();
            // Ignore monotonic tokens only; quote identity, scope, offsets, evidence and instruction must match.
            for t in [&mut fresh, &mut request] {
                for r in &mut t.anchor.ranges {
                    r.revision = 0;
                }
            }
            ensure(
                Self::request_hash(&fresh)? == Self::request_hash(&request)?,
                "HISTORY_BLOCKED",
            )?;
            let mut base = state.clone();
            base.blocks.retain(|b| ids.contains(&b.id));
            ensure(
                base.blocks.len() == original.base.blocks.len()
                    && base.blocks.iter().zip(&original.base.blocks).all(|(a, b)| {
                        a.id == b.id && a.kind == b.kind && a.attrs == b.attrs && a.runs == b.runs
                    }),
                "HISTORY_BLOCKED",
            )?;
            let mut fresh = thread.clone();
            self.hydrate_review_thread(&mut fresh)?;
            review::validate_anchor(state, &fresh.anchor)
                .map_err(|_| ManuscriptError("HISTORY_BLOCKED", None))?;
            if let Some(slot) = &fresh.anchor.slot {
                review::validate_slot(state, slot)
                    .map_err(|_| ManuscriptError("HISTORY_BLOCKED", None))?;
            }
            let mut p = planning::empty();
            p.evidence = thread.evidence.clone();
            ensure(
                self.manifest(c, &p)?.0 == original.evidence,
                "HISTORY_BLOCKED",
            )?;
            let ctx = Context {
                request_hash: Self::request_hash(&fresh)?,
                tokens: Self::review_tokens_for(c, &fresh, Some(state))?,
                thread: fresh,
                base,
                evidence: original.evidence,
                conversation: original.conversation,
            };
            Ok(ctx)
        })();
        match validate {
            Ok(ctx) => {
                let h = self.object(&db(serde_json::to_vec(&ctx))?)?;
                let _ = entry;
                Ok((candidate, h, Some(ctx)))
            }
            Err(e) if e.0 == "STORAGE_UNAVAILABLE" => Err(e),
            Err(_) => Ok((candidate, String::new(), None)),
        }
    }
}
