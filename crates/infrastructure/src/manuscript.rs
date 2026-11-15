use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write};
type Result<T> = std::result::Result<T, ManuscriptError>;
fn db<T>(r: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    r.map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE"))
}
fn hash(bytes: &[u8]) -> String {
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
    fn object(&self, bytes: &[u8]) -> Result<String> {
        let digest = hash(bytes);
        let path = self.directory.join("objects").join(&digest);
        if path.exists() {
            if db(std::fs::read(&path))? != bytes {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
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
    fn load(&self, c: &Connection) -> Result<ManuscriptState> {
        let row=db(c.query_row("SELECT id,workspace_stage,working_revision,snapshot_hash FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<String>>(3)?))).optional())?.ok_or(ManuscriptError("PROJECT_NOT_FOUND"))?;
        let mut state = if let Some(digest) = row.3 {
            let bytes = db(std::fs::read(self.directory.join("objects").join(&digest)))?;
            if hash(&bytes) != digest {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
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
            return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
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
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
            let bytes = db(std::fs::read(self.directory.join("objects").join(&digest)))?;
            if id != b.id
                || position != count
                || revision != b.revision
                || hash(&bytes) != digest
                || db(serde_json::from_slice::<Block>(&bytes))? != *b
            {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
            }
            count += 1;
        }
        if count != state.blocks.len() {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
        }
        Ok(state)
    }
    pub(super) fn verify_manuscript(&self) -> std::result::Result<(), Error> {
        let c = storage(self.connection.lock())?;
        if read_project(&c)?.is_some() {
            let state = self.load(&c).map_err(|_| Error::Storage)?;
            if read_project(&c)?.is_some_and(|p| p.working_revision != state.working_revision) {
                return Err(Error::Storage);
            }
        }
        Ok(())
    }
    fn outcome(c: &Connection, id: &str) -> Result<Option<(String, String)>> {
        db(c.query_row(
            "SELECT request_digest,outcome_json FROM command_receipts WHERE request_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())
    }
    fn decode(outcome: &str) -> Result<CommandReceipt> {
        let value: serde_json::Value = db(serde_json::from_str(outcome))?;
        if let Some(code) = value.get("error").and_then(|v| v.as_str()) {
            const CODES: &[&str] = &[
                "REVISION_EXHAUSTED",
                "PROJECT_NOT_FOUND",
                "REVISION_CONFLICT",
                "CONTENT_LOCKED",
                "TASK_USING_CONTENT",
                "OBJECT_NOT_FOUND",
                "DOCUMENT_TOO_LARGE",
                "INVALID_REQUEST",
                "DOCUMENT_INVALID",
            ];
            return Err(ManuscriptError(
                CODES
                    .iter()
                    .copied()
                    .find(|known| *known == code)
                    .unwrap_or("STORAGE_UNAVAILABLE"),
            ));
        }
        db(serde_json::from_value(value))
    }
}
impl ManuscriptRepository for SqliteProjectRepository {
    fn read_manuscript(&self) -> Result<ManuscriptState> {
        let c = db(self.connection.lock())?;
        self.load(&c)
    }
    fn command_receipt(&self, id: &str) -> Result<CommandReceipt> {
        if !manuscript::uuid4(id) {
            return Err(ManuscriptError("INVALID_REQUEST"));
        }
        let c = db(self.connection.lock())?;
        let (_, outcome) = Self::outcome(&c, id)?.ok_or(ManuscriptError("COMMAND_NOT_FOUND"))?;
        Self::decode(&outcome)
    }
    fn execute_manuscript(&self, command: &ManuscriptCommand) -> Result<CommandReceipt> {
        let (request, project_id, _) = manuscript::envelope(command);
        if !manuscript::uuid4(request) {
            return Err(ManuscriptError("INVALID_REQUEST"));
        }
        let digest = hash(&db(serde_json::to_vec(command))?);
        let mut c = db(self.connection.lock())?;
        if let Some((previous, outcome)) = Self::outcome(&c, request)? {
            if previous != digest {
                return Err(ManuscriptError("REQUEST_ID_CONFLICT"));
            }
            return Self::decode(&outcome);
        }
        let project = read_project(&c).map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE"))?;
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
            return Err(ManuscriptError("PROJECT_NOT_FOUND"));
        };
        let before = self.load(&c)?;
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
        let (transition, tombstone_revisions) = match (|| {
            if manuscript::envelope(command).2 != before.working_revision {
                return Err(ManuscriptError("REVISION_CONFLICT"));
            }
            if let ManuscriptCommand::ApplyDocumentEdit { payload, .. } = command {
                let g = &payload.group;
                let previous=db(c.query_row("SELECT client_session_id,group_sequence,kind,closed FROM edit_groups WHERE group_id=?1",[&g.group_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?))).optional())?;
                let kind = match g.kind {
                    EditGroupKind::Typing => "typing",
                    _ => "discrete",
                };
                if previous
                    .as_ref()
                    .is_some_and(|(session, sequence, old_kind, closed)| {
                        *closed
                            || session != &g.client_session_id
                            || sequence.checked_add(1) != Some(g.group_sequence)
                            || old_kind != kind
                    })
                    || (previous.is_none() && g.group_sequence != 1)
                {
                    return Err(ManuscriptError("INVALID_REQUEST"));
                }
            }
            let transition =
                manuscript::apply(&before, command, &identities, self.policy.as_ref())?;
            // Allocate deleted identities through the same recorded preflight path
            // as surviving block revisions, before any object or state writes.
            let mut tombstone_revisions = BTreeMap::new();
            for id in &transition.affected {
                if !transition.state.blocks.iter().any(|block| &block.id == id) {
                    let previous = identities
                        .get(id)
                        .ok_or(ManuscriptError("DOCUMENT_INVALID"))?;
                    tombstone_revisions.insert(id.clone(), manuscript::next_revision(*previous)?);
                }
            }
            Ok((transition, tombstone_revisions))
        })() {
            Ok(v) => v,
            Err(error) => {
                let outcome = serde_json::json!({"error":error.0}).to_string();
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
        let before_hash =
            if changed || matches!(command, ManuscriptCommand::ApplyDocumentEdit { .. }) {
                Some(self.object(&db(serde_json::to_vec(&before))?)?)
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
        let transaction = db(c.transaction())?;
        let current_revision: i64 = db(transaction.query_row(
            "SELECT working_revision FROM manuscripts WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        if current_revision != before.working_revision {
            return Err(ManuscriptError("REVISION_CONFLICT"));
        }
        // Recheck the policy at the commit boundary, after object preparation.
        if let Err(error) = self
            .policy
            .validate(&before, &transition.state, &transition.affected)
        {
            db(transaction.execute(
                "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                params![
                    request,
                    digest,
                    serde_json::json!({"error":error.0}).to_string()
                ],
            ))?;
            db(transaction.commit())?;
            return Err(error);
        }
        if changed {
            let snapshot = snapshot
                .as_ref()
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
            db(transaction.execute("DELETE FROM blocks", []))?;
            for (position, block) in transition.state.blocks.iter().enumerate() {
                let payload = payloads
                    .get(&block.id)
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
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
                } else {
                    let revision = *tombstone_revisions
                        .get(id)
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
                    let previous = identities
                        .get(id)
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
                    let updated=db(transaction.execute(
                        "UPDATE object_identities SET high_water=?2,tombstoned=1 WHERE id=?1 AND high_water=?3 AND tombstoned=0",
                        params![id, revision,previous],
                    ))?;
                    if updated != 1 {
                        return Err(ManuscriptError("STORAGE_UNAVAILABLE"));
                    }
                    revision
                };
                revisions.push(BlockRevision {
                    id: id.clone(),
                    revision,
                });
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
        if let ManuscriptCommand::ApplyDocumentEdit { payload, .. } = command {
            let g = &payload.group;
            let before_hash = before_hash
                .as_ref()
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?;
            db(transaction.execute("INSERT INTO edit_groups VALUES(?1,?2,?3,?4,?5,?6,0) ON CONFLICT(group_id) DO UPDATE SET group_sequence=excluded.group_sequence,after_hash=excluded.after_hash",params![g.group_id,g.client_session_id,g.group_sequence,match g.kind{EditGroupKind::Typing=>"typing",_=>"discrete"},before_hash,snapshot.as_ref().ok_or(ManuscriptError("STORAGE_UNAVAILABLE"))?]))?;
        }
        let sequence = db(transaction.query_row(
            "SELECT COALESCE(MAX(sequence),0) FROM project_events",
            [],
            |r| r.get(0),
        ))?;
        let receipt = CommandReceipt {
            request_id: request.to_owned(),
            working_revision: transition.state.working_revision,
            block_revisions: revisions,
            history_revision: 0,
            cursor: 0,
            undo_count: 0,
            redo_count: 0,
            event_sequence: sequence,
            normalized: transition.normalized,
        };
        db(transaction.execute(
            "INSERT INTO command_receipts VALUES(?1,?2,?3)",
            params![request, digest, db(serde_json::to_string(&receipt))?],
        ))?;
        db(transaction.commit())?;
        Ok(receipt)
    }
}
