use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};
pub(super) type Result<T> = std::result::Result<T, ManuscriptError>;
pub(super) fn db<T>(r: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    r.map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn initialize(c: &Connection) -> std::result::Result<(), Error> {
    let id = uuid::Uuid::new_v4().to_string();
    storage(c.execute("INSERT INTO manuscripts(singleton,id,workspace_stage,schema_version,working_revision) SELECT 1,?1,'outline',1,working_revision FROM project WHERE singleton=1",[&id]))?;
    storage(c.execute("INSERT OR IGNORE INTO object_identities(id,object_type,high_water) SELECT id,'project',working_revision FROM project WHERE singleton=1",[]))?;
    storage(c.execute("INSERT INTO object_identities(id,object_type,high_water) SELECT ?1,'manuscript',working_revision FROM project WHERE singleton=1",[id]))?;
    Ok(())
}
impl SqliteProjectRepository {
    pub(super) fn object(&self, bytes: &[u8]) -> Result<String> {
        let digest = hash(bytes);
        let path = self.directory.join("objects").join(&digest);
        if path.exists() {
            if db(std::fs::read(&path))? != bytes {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            return Ok(digest);
        }
        let staging = self
            .directory
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string());
        let mut file = db(File::options().create_new(true).write(true).open(&staging))?;
        db(file.write_all(bytes))?;
        db(file.sync_all())?;
        drop(file);
        db(std::fs::rename(&staging, &path))?;
        #[cfg(unix)]
        db(File::open(self.directory.join("objects")).and_then(|f| f.sync_all()))?;
        Ok(digest)
    }
    pub(super) fn load(&self, c: &Connection) -> Result<ManuscriptState> {
        #[cfg(test)]
        self.business_read_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let row=db(c.query_row("SELECT id,workspace_stage,working_revision,snapshot_hash FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<String>>(3)?))).optional())?.ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?;
        let mut state = if let Some(digest) = row.3 {
            let bytes = db(std::fs::read(self.directory.join("objects").join(&digest)))?;
            if hash(&bytes) != digest {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
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
            let bytes = db(std::fs::read(self.directory.join("objects").join(&digest)))?;
            if id != b.id
                || position != count
                || revision != b.revision
                || hash(&bytes) != digest
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
        if read_project(&c)?.is_some() {
            let state = self.load(&c).map_err(|_| Error::Storage)?;
            self.verify_history(&c, &state)
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
                "SOURCE_TEXT_UNAVAILABLE",
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
        let mut c = db(self.connection.lock())?;
        self.execute_manuscript_locked(&mut c, command)
    }
}
impl SqliteProjectRepository {
    pub(crate) fn execute_manuscript_locked(
        &self,
        c: &mut Connection,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let (request, project_id, _) = manuscript::envelope(command);
        if !manuscript::uuid4(request) {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        }
        let digest = hash(&db(serde_json::to_vec(command))?);
        if let Some((previous, outcome)) = Self::outcome(c, request)? {
            if previous != digest {
                return Err(ManuscriptError("REQUEST_ID_CONFLICT", None));
            }
            return Self::decode(&outcome);
        }
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
        let before = self.load(c)?;
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
        let (transition, tombstone_revisions, history) = match (|| {
            if manuscript::envelope(command).2 != before.working_revision
                && !matches!(command, ManuscriptCommand::CancelPlanningTask { .. })
            {
                return Err(ManuscriptError("REVISION_CONFLICT", None));
            }
            let mut transition = self.history_transition(c, command, &before, &identities)?;
            self.coordinate_planning(c, command, &before, &mut transition)?;
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
            let history = self.history_plan(c, command, &before, &transition)?;
            Ok((transition, tombstone_revisions, history))
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
            for block in &transition.state.blocks {
                payloads.insert(
                    block.id.clone(),
                    self.object(&db(serde_json::to_vec(block))?)?,
                );
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
        let cancellation_watermark =
            if matches!(command, ManuscriptCommand::CancelPlanningTask { .. }) {
                Some(
                    self.ai_prepare_watermark(c)
                        .map_err(|e| ManuscriptError(e.0, None))?,
                )
            } else {
                None
            };
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
            if let ManuscriptCommand::AddSourceFile { payload, .. } = command {
                db(transaction.execute(
                    "UPDATE intakes SET status='cancelled',object_hash=NULL WHERE id=?1",
                    [&payload.intake_id],
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
        history.commit(&transaction)?;
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
        db(transaction.commit())?;
        Ok(receipt)
    }
}
