use super::*;
use crate::storage::{Result, db, hash};
use scenesparrow_application::manuscript::ManuscriptRepository;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use std::collections::BTreeMap;
pub(super) fn initialize(c: &Connection) -> std::result::Result<(), Error> {
    let id = uuid::Uuid::new_v4().to_string();
    storage(c.execute("INSERT INTO manuscripts(singleton,id,workspace_stage,schema_version,working_revision) SELECT 1,?1,'outline',1,working_revision FROM project WHERE singleton=1",[&id]))?;
    storage(c.execute("INSERT OR IGNORE INTO object_identities(id,object_type,high_water) SELECT id,'project',working_revision FROM project WHERE singleton=1",[]))?;
    storage(c.execute("INSERT INTO object_identities(id,object_type,high_water) SELECT ?1,'manuscript',working_revision FROM project WHERE singleton=1",[id]))?;
    Ok(())
}
impl SqliteProjectRepository {
    pub(super) fn load(&self, c: &Connection) -> Result<ManuscriptState> {
        #[cfg(test)]
        self.business_read_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let row=db(c.query_row("SELECT id,workspace_stage,working_revision,snapshot_hash FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<String>>(3)?))).optional())?.ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?;
        let mut state = if let Some(digest) = row.3 {
            let bytes = self.read_object(&digest)?;
            db(serde_json::from_slice::<ManuscriptState>(&bytes))?
        } else {
            ManuscriptState {
                manuscript_id: row.0.clone(),
                schema_version: 1,
                workspace_stage: ManuscriptStateWorkspaceStage::Outline,
                working_revision: row.2,
                blocks: vec![],
            }
        };
        if state.manuscript_id != row.0
            || state.working_revision != row.2
            || serde_json::to_value(&state.workspace_stage)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                != Some(row.1)
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        manuscript::normalize(&mut state)?;
        let mut stmt = db(
            c.prepare("SELECT id,position,revision,payload_hash FROM blocks ORDER BY position")
        )?;
        let rows = db(stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, usize>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        }))?;
        let mut count = 0;
        for row in rows {
            let (id, position, revision, digest) = db(row)?;
            let b = state
                .blocks
                .get(count)
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            let bytes = self.read_object(&digest)?;
            if id != b.id
                || position != count
                || revision != b.revision
                || db(serde_json::from_slice::<Block>(&bytes))? != *b
            {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            count += 1;
        }
        if count != state.blocks.len() {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        Ok(state)
    }
    pub(super) fn verify_manuscript(&self) -> std::result::Result<(), Error> {
        let c = storage(self.connection.lock())?;
        self.verify_export_records(&c).map_err(|_| Error::Storage)?;
        if read_project(&c)?.is_some() {
            let state = self.load(&c).map_err(|_| Error::Storage)?;
            self.verify_finalization(&c, &state)
                .map_err(|_| Error::Storage)?;
            self.verify_history(&c, &state)
                .map_err(|_| Error::Storage)?;
            self.verify_file_graph_history(&c)
                .map_err(|_| Error::Storage)?;
            if read_project(&c)?.is_some_and(|p| p.working_revision != state.working_revision) {
                return Err(Error::Storage);
            }
        }
        Ok(())
    }
    pub(crate) fn outcome(c: &Connection, id: &str) -> Result<Option<(String, String)>> {
        db(c.query_row(
            "SELECT request_digest,outcome_json FROM command_receipts WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())
    }
    pub(crate) fn decode(outcome: &str) -> Result<CommandReceipt> {
        let value: serde_json::Value = db(serde_json::from_str(outcome))?;
        if let Some(code) = value.get("error").and_then(|v| v.as_str()) {
            const CODES: &[&str] = &[
                "ANCHOR_INVALID",
                "ANCHOR_STALE",
                "REVIEW_VERSION_CONFLICT",
                "REVIEW_TASK_ACTIVE",
                "PENDING_CANDIDATE",
                "CANDIDATE_STALE",
                "CANDIDATE_CLAIMED",
                "CANDIDATE_INVALID",
                "CANDIDATE_OVERLAP",
                "PATCH_OUT_OF_SCOPE",
                "BRIEF_INVALID",
                "OUTLINE_INVALID",
                "OUTLINE_REQUIRED",
                "STAGE_CONFLICT",
                "DRAFT_ALREADY_EXISTS",
                "PREFLIGHT_STALE",
                "EVIDENCE_NOT_READY",
                "EVIDENCE_CHOICE_REQUIRED",
                "PLANNING_TASK_ACTIVE",
                "PLANNING_RESULT_STALE",
                "HISTORY_DIVERGED",
                "DRAFT_STRUCTURE_INVALID",
                "INVALID_OUTPUT",
                "OUTPUT_TRUNCATED",
                "CONFIGURATION_STALE",
                "CONFIGURATION_REQUIRED",
                "CONFIGURATION_UNAVAILABLE",
                "CREDENTIAL_UNAVAILABLE",
                "CONTEXT_LIMIT",
                "INVALID_INPUT",
                "ARTIFACT_MISMATCH",
                "PREPARATION_UNAVAILABLE",
                "CONSUMER_UNAVAILABLE",
                "RUN_NOT_FOUND",
                "INVALID_SETTINGS",
                "PROTOCOL_MISMATCH",
                "CAPABILITY_UNSUPPORTED",
                "INPUT_TOO_LARGE",
                "QUEUE_FULL",
                "CONSUMER_CANCELLED",
                "RESULT_UNAVAILABLE",
                "ALREADY_APPLIED",
                "INVALID_RETRY",
                "HISTORY_EMPTY",
                "HISTORY_CONFLICT",
                "HISTORY_BLOCKED",
                "REVISION_EXHAUSTED",
                "PROJECT_NOT_FOUND",
                "REVISION_CONFLICT",
                "CONTENT_LOCKED",
                "TASK_USING_CONTENT",
                "OBJECT_NOT_FOUND",
                "DOCUMENT_TOO_LARGE",
                "INVALID_REQUEST",
                "DOCUMENT_INVALID",
                "INVALID_URL",
                "IMPORT_STALE",
                "GRAPH_TOPOLOGY_UNSUPPORTED",
                "GRAPH_OBSERVATION_STALE",
                "GRAPH_INVALID",
                "GRAPH_BUDGET_EXCEEDED",
                "GRAPH_FORBIDDEN_PATH",
                "GRAPH_REQUIRED_FILE_MISSING",
                "GRAPH_NAME_MISMATCH",
                "GRAPH_REGISTRATION_REQUIRED",
                "GRAPH_BASE_MISMATCH",
                "PATH_INVALID",
                "PATH_COLLISION",
                "FORMAT_INVALID",
                "FORMAT_UNSUPPORTED",
                "SOURCE_PROJECT_MISMATCH",
                "SOURCE_FUTURE_READ_ONLY",
                "SOURCE_READ_UNAVAILABLE",
                "SOURCE_TEXT_UNAVAILABLE",
                "SOURCE_BASE_MISMATCH",
                "SOURCE_RECOVERY_REQUIRED",
                "SOURCE_EXTERNAL_CHANGE",
                "SOURCE_CANDIDATE_STALE",
                "SOURCE_CANDIDATE_INVALID",
                "SOURCE_RECOVERY_STALE",
                "SOURCE_REQUIRED_FILE_DELETED",
                "SOURCE_SEMANTIC_UNSUPPORTED",
                "SOURCE_CAPABILITY_UNSUPPORTED",
                "SOURCE_PATH_UNSAFE",
                "IDENTITY_MISSING",
                "IDENTITY_DUPLICATE",
                "IDENTITY_AMBIGUOUS",
                "IDENTITY_INVALID",
                "IDENTITY_PLACEMENT_UNSUPPORTED",
                "SOURCE_PARSE_FAILED",
                "SOURCE_UTF8_INVALID",
                "SOURCE_RANGE_INVALID",
                "SOURCE_PATCH_OVERLAP",
            ];
            return Err(ManuscriptError(
                CODES
                    .iter()
                    .copied()
                    .find(|known| *known == code)
                    .unwrap_or("STORAGE_UNAVAILABLE"),
                value
                    .get("details")
                    .filter(|v| !v.is_null())
                    .map(|v| db(serde_json::from_value(v.clone())))
                    .transpose()?,
            ));
        }
        db(serde_json::from_value(value))
    }
}
impl ManuscriptRepository for SqliteProjectRepository {
    fn read_history(&self) -> Result<HistoryState> {
        let c = db(self.connection.lock())?;
        Self::history_metadata(&c)
    }
    fn read_manuscript(&self) -> Result<ManuscriptState> {
        let c = db(self.connection.lock())?;
        self.load(&c)
    }
    fn command_receipt(&self, id: &str) -> Result<CommandReceipt> {
        if !manuscript::uuid4(id) {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        }
        let c = db(self.connection.lock())?;
        let (_, outcome) =
            Self::outcome(&c, id)?.ok_or(ManuscriptError("COMMAND_NOT_FOUND", None))?;
        Self::decode(&outcome)
    }
    fn execute_manuscript(&self, command: &ManuscriptCommand) -> Result<CommandReceipt> {
        let waiting = std::time::Instant::now();
        let mut c = db(self.connection.lock())?;
        if std::env::var_os("SCENESPARROW_PROFILE_WRITES").is_some() {
            eprintln!(
                "{}",
                serde_json::json!({"event":"storage.writerWait","durationUs":waiting.elapsed().as_micros()})
            );
        }
        self.execute_manuscript_locked(&mut c, command)
    }
}
impl SqliteProjectRepository {
    pub(crate) fn execute_manuscript_locked(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        self.execute_manuscript_source_locked(c, command, None)
    }
    pub(crate) fn execute_manuscript_source_locked(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
        source_request: Option<&crate::open_source::SourceSaveRequest>,
    ) -> Result<CommandReceipt> {
        self.execute_manuscript_source_action_locked(c, command, source_request, None)
    }
    pub(crate) fn execute_manuscript_source_action_locked(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
        source_request: Option<&crate::open_source::SourceSaveRequest>,
        resolution: Option<&AuthoredSourceResolveRequest>,
    ) -> Result<CommandReceipt> {
        self.execute_manuscript_graph_locked(c, command, source_request, resolution, None)
    }
    pub(crate) fn execute_manuscript_graph_locked(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
        source_request: Option<&crate::open_source::SourceSaveRequest>,
        resolution: Option<&AuthoredSourceResolveRequest>,
        graph_action: Option<&crate::open_source::graph::GraphAction>,
    ) -> Result<CommandReceipt> {
        let (request, project_id, _) = manuscript::envelope(command);
        if !manuscript::uuid4(request) && !graph_action.is_some_and(|a| a.rename.is_some()) {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        }
        let digest = if let Some(action) = graph_action {
            action.digest.clone()
        } else {
            hash(&if let Some(resolution) = resolution {
                db(serde_json::to_vec(resolution))?
            } else if let Some(source) = source_request {
                db(serde_json::to_vec(source))?
            } else {
                db(serde_json::to_vec(command))?
            })
        };
        if let Some((previous, outcome)) = Self::outcome(c, request)? {
            if previous != digest {
                return Err(ManuscriptError("REQUEST_ID_CONFLICT", None));
            }
            return Self::decode(&outcome);
        }
        self.guard_source_recovery()?;
        if source_request.is_some() {
            self.guard_source_application(c)?;
        }
        Self::expire_downstream_now(c)?;
        let project = read_project(c).map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?;
        let Some(_project) = project.filter(|p| p.id == project_id) else {
            let transaction = db(c.transaction())?;
            db(transaction.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request,
                    digest,
                    serde_json::json!({"error":"PROJECT_NOT_FOUND"}).to_string()
                ],
            ))?;
            db(transaction.commit())?;
            return Err(ManuscriptError("PROJECT_NOT_FOUND", None));
        };
        if matches!(command, ManuscriptCommand::CloseEditGroup { .. }) {
            return self.close_group_fast(c, command, &digest);
        }
        let mut profile = crate::storage::operation::Operation::begin(match command {
            ManuscriptCommand::ApplyDocumentEdit { .. } => "edit",
            ManuscriptCommand::UndoProject { .. } => "undo",
            ManuscriptCommand::RedoProject { .. } => "redo",
            _ => "metadata",
        });
        let before = self.load(c)?;
        profile.phase("load");
        let sources_before = Self::source_members(c)?;
        let mut identities = BTreeMap::new();
        {
            let mut stmt = db(c.prepare("SELECT id,high_water FROM object_identities"))?;
            let rows =
                db(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))))?;
            for row in rows {
                let (id, rev) = db(row)?;
                identities.insert(id, rev);
            }
        }
        let (
            transition,
            tombstone_revisions,
            history,
            prepared_reviews,
            prepared_finalization,
            graph_update,
        ) = match (|| {
            if manuscript::envelope(command).2 != before.working_revision
                && !matches!(
                    command,
                    ManuscriptCommand::CancelPlanningTask { .. }
                        | ManuscriptCommand::CancelReviewTask { .. }
                )
            {
                return Err(ManuscriptError("REVISION_CONFLICT", None));
            }
            profile.phase("identities");
            let resolved_request = resolution
                .map(|request| self.resolution_source_request(c, request))
                .transpose()?;
            let graph_source = if let Some(action) = graph_action {
                let ManuscriptCommand::ApplyDocumentEdit { payload, .. } = command else {
                    return Err(ManuscriptError("INVALID_REQUEST", None));
                };
                Some(self.graph_source_request(c, action, &payload.group)?)
            } else {
                None
            };
            let mut transition = if let Some(source) = graph_source
                .as_ref()
                .or(resolved_request.as_ref())
                .or(source_request)
            {
                self.source_edit_transition(c, source, &before, &identities)?
            } else {
                self.history_transition(c, command, &before, &identities)?
            };
            profile.phase("domain-transition");
            self.coordinate_planning(c, command, &before, &mut transition)?;
            self.coordinate_reviews(c, command, &before, &mut transition)?;
            self.prepare_transition_source(c, &before, &mut transition, command)?;
            let graph_update =
                self.prepare_graph_transition(c, command, &mut transition, graph_action)?;
            if let Err(mut error) = Self::guard_finalization(c, &before, &transition) {
                if matches!(
                    command,
                    ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
                ) {
                    error = ManuscriptError::history_blocked(error.0, &transition.affected);
                } else if matches!(command, ManuscriptCommand::AcceptReviewCandidates { .. }) {
                    let checks = self.review_acceptance_checks(c, command)?;
                    let blocked = error
                        .1
                        .as_ref()
                        .map(|d| d.affected_ids.clone())
                        .unwrap_or_default();
                    let checks = checks
                        .into_iter()
                        .filter(|(_, ctx)| ctx.base.blocks.iter().any(|b| blocked.contains(&b.id)))
                        .collect::<Vec<_>>();
                    error.1 = Some(Self::review_acceptance_error(&checks, error.0));
                }
                return Err(error);
            }
            self.guard_reviews(c, command, &before, &transition)?;
            self.guard_planning(c, command, &before, &transition)?;
            // Allocate deleted identities through the same recorded preflight path
            // as surviving block revisions, before any object or state writes.
            let mut tombstone_revisions = BTreeMap::new();
            for id in &transition.affected {
                if !transition.state.blocks.iter().any(|block| &block.id == id)
                    && !transition
                        .sources
                        .as_ref()
                        .unwrap_or(&sources_before)
                        .iter()
                        .any(|source| &source.id == id)
                {
                    let previous = identities
                        .get(id)
                        .ok_or(ManuscriptError("DOCUMENT_INVALID", None))?;
                    tombstone_revisions.insert(id.clone(), manuscript::next_revision(*previous)?);
                }
            }
            profile.phase("guards-coordination");
            let mut history = self.history_plan(c, command, &before, &transition)?;
            history.bind_file_graphs(command, graph_update.as_ref())?;
            profile.phase("history");
            let prepared_reviews = self.prepare_reviews(c, command, &before, &transition)?;
            profile.phase("review-projections");
            let prepared_finalization = self.prepare_finalization(c, &transition)?;
            profile.phase("finalization");
            Ok((
                transition,
                tombstone_revisions,
                history,
                prepared_reviews,
                prepared_finalization,
                graph_update,
            ))
        })() {
            Ok(v) => v,
            Err(error) => {
                if error.0 == "STORAGE_UNAVAILABLE" {
                    return Err(error);
                }
                let outcome = serde_json::json!({"error":error.0,"details":error.1}).to_string();
                let transaction = db(c.transaction())?;
                db(transaction.execute(
                    "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                    params![request, digest, outcome],
                ))?;
                db(transaction.commit())?;
                return Err(error);
            }
        };
        profile.phase("transition-history-policy");
        let changed = transition.state.working_revision != before.working_revision;
        let mut revisions = vec![];
        // The repository mutex is the writer coordinator. Promote all immutable bytes
        // before the short transaction; orphan objects after a failed commit are safe.
        let snapshot = if changed || matches!(command, ManuscriptCommand::ApplyDocumentEdit { .. })
        {
            Some(self.object(&db(serde_json::to_vec(&transition.state))?)?)
        } else {
            None
        };
        let mut payloads = BTreeMap::new();
        if changed {
            let old: BTreeMap<_, _> = before.blocks.iter().map(|b| (&b.id, b)).collect();
            let mut stmt = db(c.prepare("SELECT id,payload_hash FROM blocks"))?;
            let verified: BTreeMap<String, String> =
                db(stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))))?
                    .map(db)
                    .collect::<Result<_>>()?;
            for block in &transition.state.blocks {
                let payload = if old
                    .get(&block.id)
                    .is_some_and(|previous| **previous == *block)
                {
                    let digest = verified
                        .get(&block.id)
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                    // load verified this exact payload in this writer operation. Never
                    // recreate a vanished immutable reference from an in-memory copy.
                    self.read_object(digest)?;
                    digest.clone()
                } else {
                    self.object(&db(serde_json::to_vec(block))?)?
                };
                payloads.insert(block.id.clone(), payload);
            }
        }
        let import_metadata = if let ManuscriptCommand::CommitManuscriptImport { payload, .. } =
            command
        {
            let (input,result,attempt):(String,String,i64)=db(c.query_row("SELECT input_hash,result_hash,attempt FROM document_attempts WHERE id=?1 AND status='ready'",[&payload.prepared_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))))?;
            let parsed: DocumentResult = db(serde_json::from_slice(&self.read_object(&result)?))?;
            Some((
                payload.prepared_id.clone(),
                input,
                result,
                attempt,
                parsed.parser,
            ))
        } else {
            None
        };
        profile.phase("immutable-objects");
        let review_checks = self.review_acceptance_checks(c, command)?;
        let cancellation_watermark =
            if matches!(command, ManuscriptCommand::CancelPlanningTask { .. })
                || Self::review_cancels_execution(c, command, &transition)?
            {
                Some(
                    self.ai_prepare_watermark(c)
                        .map_err(|e| ManuscriptError(e.0, None))?,
                )
            } else {
                None
            };
        let preparation = if let Some(update) = &graph_update {
            self.prepare_graph_intent(c, request, &digest, &transition, update, resolution)
        } else {
            self.prepare_source_intent(c, request, &digest, &transition, resolution)
        };
        let source_intent = match preparation {
            Ok(intent) => intent,
            Err(error) => {
                if error.0 != "STORAGE_UNAVAILABLE" && self.guard_source_recovery().is_ok() {
                    let tx = db(c.transaction())?;
                    db(tx.execute(
                        "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                        params![
                            request,
                            digest,
                            serde_json::json!({"error":error.0,"details":error.1}).to_string()
                        ],
                    ))?;
                    db(tx.commit())?;
                }
                return Err(error);
            }
        };
        if let Some(intent) = &source_intent {
            self.promote_source_intent(intent)?;
        }
        let transaction = db(c.transaction())?;
        let current_revision: i64 = db(transaction.query_row(
            "SELECT working_revision FROM manuscripts WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        let precondition = if current_revision != before.working_revision {
            Err(ManuscriptError("REVISION_CONFLICT", None))
        } else {
            history.recheck(&transaction)
        };
        if let Err(error) = precondition {
            if error.0 == "STORAGE_UNAVAILABLE" {
                return Err(error);
            }
            db(transaction.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request,
                    digest,
                    serde_json::json!({"error":error.0,"details":error.1}).to_string()
                ],
            ))?;
            db(transaction.commit())?;
            return Err(error);
        }
        self.guard_planning(&transaction, command, &before, &transition)?;
        self.guard_reviews(&transaction, command, &before, &transition)?;
        Self::recheck_review_acceptance(&transaction, &review_checks)?;
        Self::guard_finalization(&transaction, &before, &transition)?;
        // Recheck the policy at the commit boundary, after object preparation.
        if let Err(mut error) =
            self.policy
                .validate(&before, &transition.state, &transition.affected)
        {
            if matches!(
                command,
                ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
            ) {
                error = ManuscriptError::history_blocked(error.0, &transition.affected);
            } else if matches!(command, ManuscriptCommand::AcceptReviewCandidates { .. })
                && error.1.is_none()
            {
                error.1 = Some(Self::review_acceptance_error(&review_checks, error.0));
            }
            db(transaction.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request,
                    digest,
                    serde_json::json!({"error":error.0,"details":error.1}).to_string()
                ],
            ))?;
            db(transaction.commit())?;
            return Err(error);
        }
        if changed {
            let snapshot = snapshot
                .as_ref()
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
            db(transaction.execute("DELETE FROM blocks", []))?;
            for (position, block) in transition.state.blocks.iter().enumerate() {
                let payload = payloads
                    .get(&block.id)
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                db(transaction.execute("INSERT INTO object_identities VALUES(?1,'block',?2,0) ON CONFLICT(id) DO UPDATE SET high_water=excluded.high_water,tombstoned=0",params![block.id,block.revision]))?;
                db(transaction.execute(
                    "INSERT OR IGNORE INTO content_revisions VALUES(?1,?2,?3)",
                    params![block.id, block.revision, payload],
                ))?;
                db(transaction.execute(
                    "INSERT INTO blocks VALUES(?1,?2,?3,?4,?5)",
                    params![
                        block.id,
                        transition.state.manuscript_id,
                        position,
                        block.revision,
                        payload
                    ],
                ))?;
            }
            for id in &transition.affected {
                let revision = if let Some(b) = transition.state.blocks.iter().find(|b| &b.id == id)
                {
                    b.revision
                } else if let Some(s) = transition
                    .sources
                    .as_ref()
                    .unwrap_or(&sources_before)
                    .iter()
                    .find(|s| &s.id == id)
                {
                    s.revision
                } else {
                    let revision = *tombstone_revisions
                        .get(id)
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                    let previous = identities
                        .get(id)
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?;
                    let updated=db(transaction.execute(
                        "UPDATE object_identities SET high_water=?2,tombstoned=1 WHERE id=?1 AND high_water=?3 AND tombstoned=0",
                        params![id, revision,previous],
                    ))?;
                    if updated != 1 {
                        return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
                    }
                    revision
                };
                revisions.push(BlockRevision {
                    id: id.clone(),
                    revision,
                });
            }
            self.commit_sources(&transaction, &sources_before, &transition)?;
            let consumed_intake = match command {
                ManuscriptCommand::AddSourceFile { payload, .. } => Some(&payload.intake_id),
                ManuscriptCommand::RefreshSourceFile { payload, .. } => Some(&payload.intake_id),
                _ => None,
            };
            if let Some(intake_id) = consumed_intake {
                db(transaction.execute(
                    "UPDATE intakes SET status='cancelled',object_hash=NULL WHERE id=?1",
                    [intake_id],
                ))?;
            }
            if let Some((prepared, input, result, attempt, parser)) = &import_metadata {
                let matches=db(transaction.query_row("SELECT 1 FROM document_attempts WHERE id=?1 AND attempt=?2 AND status='ready' AND input_hash=?3 AND result_hash=?4",params![prepared,attempt,input,result],|_|Ok(())).optional())?.is_some();
                if !matches {
                    return Err(ManuscriptError("IMPORT_STALE", None));
                }
                for block in &transition.state.blocks {
                    if !before.blocks.iter().any(|b| b.id == block.id) {
                        db(transaction.execute(
                            "INSERT INTO import_provenance VALUES(?1,?2,?3,?4)",
                            params![block.id, input, result, parser],
                        ))?;
                    }
                }
                db(transaction.execute(
                    "UPDATE document_attempts SET status='cancelled',attempt=attempt+1 WHERE id=?1",
                    [prepared],
                ))?;
            }
            if transition.sources.is_some() {
                db(transaction.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'sources.changed',?2)",params![request,serde_json::json!({"workingRevision":transition.state.working_revision,"affectedIds":transition.affected}).to_string()]))?;
            }
            db(transaction.execute("UPDATE manuscripts SET snapshot_hash=?1,workspace_stage=?2,working_revision=?3 WHERE singleton=1",params![snapshot,match transition.state.workspace_stage{ManuscriptStateWorkspaceStage::Draft=>"draft",_=>"outline"},transition.state.working_revision]))?;
            db(transaction.execute(
                "UPDATE project SET working_revision=?1 WHERE singleton=1",
                [transition.state.working_revision],
            ))?;
            db(transaction.execute(
                "UPDATE object_identities SET high_water=?1 WHERE id=?2",
                params![
                    transition.state.working_revision,
                    transition.state.manuscript_id
                ],
            ))?;

            db(transaction.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'manuscript.changed',?2)",params![request,serde_json::json!({"projectId":project_id,"workingRevision":transition.state.working_revision,"affectedIds":transition.affected}).to_string()]))?;
        }
        self.commit_planning(&transaction, command, &before, &transition)?;
        self.commit_reviews(
            &transaction,
            command,
            &before,
            &transition,
            &prepared_reviews,
            history.current_entry_id(),
        )?;
        Self::commit_finalization(
            &transaction,
            command,
            &transition,
            &prepared_finalization,
            if history.changed {
                history.current_entry_id()
            } else {
                None
            },
        )?;
        history.commit(&transaction)?;
        Self::prune_finalization(&transaction)?;
        if history.changed {
            db(transaction.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'history.changed',?2)",params![request,db(serde_json::to_string(&history.metadata))?]))?;
        }
        let sequence = db(transaction.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM project_events",
            [],
            |r| r.get(0),
        ))?;
        let receipt = CommandReceipt {
            request_id: request.to_owned(),
            working_revision: transition.state.working_revision,
            source_revisions: if transition.sources.is_some() {
                Some(
                    revisions
                        .iter()
                        .filter(|r| {
                            sources_before.iter().any(|s| s.id == r.id)
                                || transition
                                    .sources
                                    .as_ref()
                                    .is_some_and(|ss| ss.iter().any(|s| s.id == r.id))
                        })
                        .cloned()
                        .collect(),
                )
            } else {
                None
            },
            block_revisions: revisions
                .into_iter()
                .filter(|r| {
                    before.blocks.iter().any(|b| b.id == r.id)
                        || transition.state.blocks.iter().any(|b| b.id == r.id)
                })
                .collect(),
            history_revision: history.metadata.history_revision,
            cursor: history.metadata.cursor,
            undo_count: history.metadata.undo_count,
            redo_count: history.metadata.redo_count,
            undo_label: history.metadata.undo_label.clone(),
            redo_label: history.metadata.redo_label.clone(),
            event_sequence: sequence,
            normalized: transition.normalized,
        };
        db(transaction.execute(
            "INSERT INTO command_receipts VALUES(?1,?2,?3)",
            params![request, digest, db(serde_json::to_string(&receipt))?],
        ))?;
        db(transaction.execute("DELETE FROM project_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM project_events)",[]))?;
        if let Some(watermark) = cancellation_watermark {
            self.ai_commit_watermark(&transaction, watermark)
                .map_err(|e| ManuscriptError(e.0, None))?;
        }
        self.commit_source_intent(&transaction, source_intent.as_ref(), command)?;
        db(transaction.execute("INSERT OR IGNORE INTO approved_file_graphs SELECT b.baseline_id,g.graph_hash,'approval'  FROM manuscript_baseline b CROSS JOIN accepted_file_graph g WHERE b.baseline_id IS NOT NULL",[]))?;
        db(transaction.execute("DELETE FROM approved_file_graphs WHERE baseline_id NOT IN (SELECT id FROM approved_manifests)",[]))?;

        if source_intent.is_none()
            && let Some(action) = graph_action
            && let Some((previous, title)) = &action.rename
        {
            db(transaction.execute("INSERT INTO project_rename_receipts(request_id,project_id,previous_title,title) VALUES(?1,?2,?3,?4)",params![request,project_id,previous,title]))?;
        }
        self.source_cut("before-sql")?;
        profile.phase("sql-before-commit");
        db(transaction.commit())?;
        self.finish_source_intent(source_intent.as_ref())?;
        profile.phase("commit-fsync");
        Ok(receipt)
    }
}

impl SqliteProjectRepository {
    /// Closing a group changes only compact grouping/history metadata. It neither
    /// captures nor acknowledges a new body, and needs no body/source projection.
    fn close_group_fast(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
        digest: &str,
    ) -> Result<CommandReceipt> {
        let (request, _, expected) = manuscript::envelope(command);
        let prepared = (|| {
            let (id, stage, schema, revision): (String, String, i64, i64) = db(c.query_row(
                "SELECT id,workspace_stage,schema_version,working_revision FROM manuscripts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ))?;
            if revision != expected {
                return Err(ManuscriptError("REVISION_CONFLICT", None));
            }
            let before = ManuscriptState {
                manuscript_id: id,
                schema_version: schema,
                workspace_stage: db(serde_json::from_value(serde_json::json!(stage)))?,
                working_revision: revision,
                blocks: vec![],
            };
            let transition = self.history_transition(c, command, &before, &BTreeMap::new())?;
            let history = self.history_plan(c, command, &before, &transition)?;
            Ok((revision, history))
        })();
        let (revision, history) = match prepared {
            Ok(value) => value,
            Err(error) => {
                if error.0 == "STORAGE_UNAVAILABLE" {
                    return Err(error);
                }
                let tx = db(c.transaction())?;
                db(tx.execute(
                    "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                    params![
                        request,
                        digest,
                        serde_json::json!({"error":error.0,"details":error.1}).to_string()
                    ],
                ))?;
                db(tx.commit())?;
                return Err(error);
            }
        };
        let tx = db(c.transaction())?;
        let current: i64 =
            db(tx.query_row("SELECT working_revision FROM manuscripts", [], |r| r.get(0)))?;
        if current != revision {
            return Err(ManuscriptError("REVISION_CONFLICT", None));
        }
        history.recheck(&tx)?;
        history.commit(&tx)?;
        if history.changed {
            db(tx.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'history.changed',?2)",params![request,db(serde_json::to_string(&history.metadata))?]))?;
        }
        let sequence = db(tx.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM project_events",
            [],
            |r| r.get(0),
        ))?;
        let receipt = CommandReceipt {
            request_id: request.into(),
            working_revision: revision,
            block_revisions: vec![],
            source_revisions: None,
            history_revision: history.metadata.history_revision,
            cursor: history.metadata.cursor,
            undo_count: history.metadata.undo_count,
            redo_count: history.metadata.redo_count,
            undo_label: history.metadata.undo_label.clone(),
            redo_label: history.metadata.redo_label.clone(),
            event_sequence: sequence,
            normalized: false,
        };
        db(tx.execute(
            "INSERT INTO command_receipts VALUES(?1,?2,?3)",
            params![request, digest, db(serde_json::to_string(&receipt))?],
        ))?;
        db(tx.execute("DELETE FROM project_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM project_events)",[]))?;
        db(tx.commit())?;
        Ok(receipt)
    }
}
