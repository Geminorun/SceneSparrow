use super::manuscript::{Result, db, hash};
use super::*;
use scenesparrow_application::manuscript::DocumentRepository;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, BusinessSnapshot, ManuscriptError, Transition},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    process::{Command, Stdio},
    time::Instant,
};
const MAX_INPUT: u64 = 25 * 1024 * 1024;
const MAX_RESULT: u64 = 20 * 1024 * 1024;
fn invalid<T>() -> Result<T> {
    Err(ManuscriptError("INVALID_REQUEST", None))
}
fn id_check(id: &str) -> Result<()> {
    if manuscript::uuid4(id) {
        Ok(())
    } else {
        invalid()
    }
}
fn text_check(text: &str, limit: usize) -> Result<()> {
    if text.len() > limit
        || text
            .chars()
            .any(|c| c.is_control() && c != '\t' && c != '\n')
    {
        invalid()
    } else {
        Ok(())
    }
}
fn status(s: &str) -> Result<DocumentJobStatus> {
    db(serde_json::from_value(serde_json::json!(s)))
}
impl SqliteProjectRepository {
    pub(super) fn source_members(c: &Connection) -> Result<Vec<Source>> {
        let mut stmt=db(c.prepare("SELECT s.id,s.revision,s.payload_json,i.high_water,i.tombstoned,i.object_type FROM sources s LEFT JOIN object_identities i ON i.id=s.id ORDER BY s.id"))?;
        let rows = db(stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, String>(5)?,
            ))
        }))?;
        rows.map(|row| {
            let (id, revision, json, high_water, tombstoned, kind) = db(row)?;
            let source: Source = db(serde_json::from_str(&json))?;
            if source.id != id
                || source.revision != revision
                || !(1..=manuscript::MAX_REVISION).contains(&revision)
                || high_water != revision
                || tombstoned
                || kind != "source"
            {
                return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
            }
            Ok(source)
        })
        .collect()
    }

    pub(super) fn business(c: &Connection, state: &ManuscriptState) -> Result<BusinessSnapshot> {
        let mut root = BusinessSnapshot::capture(state);
        let version: i64 = db(c.pragma_query_value(None, "user_version", |r| r.get(0)))?;
        root.locks = if version >= 8 {
            Self::user_lock_ids(c)?
        } else {
            vec![]
        };
        root.planning = Some(scenesparrow_domain::planning::content_snapshot(
            &if version >= 6 {
                Self::planning_content(c)?
            } else {
                scenesparrow_domain::planning::empty()
            },
        ));
        root.reviews = if version >= 7 {
            scenesparrow_domain::review::snapshot(&Self::review_threads(c)?)
        } else {
            vec![]
        };
        root.sources = if version >= 4 {
            Self::source_members(c)?
        } else {
            vec![]
        };
        for s in &mut root.sources {
            s.revision = 0;
        }
        Ok(root)
    }
    pub(super) fn business_after(c: &Connection, t: &Transition) -> Result<BusinessSnapshot> {
        let mut root = Self::business(c, &t.state)?;
        if let Some(locks) = &t.locks {
            root.locks = locks.clone();
        }
        if let Some(reviews) = &t.reviews {
            root.reviews = scenesparrow_domain::review::snapshot(reviews);
        }
        if let Some(planning) = &t.planning {
            root.planning = Some(scenesparrow_domain::planning::content_snapshot(planning));
        }
        if let Some(sources) = &t.sources {
            root.sources = sources.clone();
            for s in &mut root.sources {
                s.revision = 0;
            }
        }
        Ok(root)
    }
    pub(super) fn read_business(&self, digest: &str) -> Result<BusinessSnapshot> {
        #[cfg(test)]
        self.business_read_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut root: BusinessSnapshot = db(serde_json::from_slice(&self.read_object(digest)?))?;
        // Applied v3 objects remain byte-for-byte immutable. A closed v1 decoder
        // upgrades only its in-memory meaning; v1 roots cannot invent membership.
        if root.version == 1 {
            if !root.sources.is_empty() {
                return invalid();
            }
            root.version = 2;
        }
        if root.version == 2 {
            if root.planning.is_some() {
                return invalid();
            }
            root.version = 3;
            root.planning = Some(scenesparrow_domain::planning::empty());
        }
        if root.version == 3 {
            if !root.reviews.is_empty() {
                return invalid();
            }
            root.version = 4;
        }
        if root.version != 4 {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        for hash in root
            .reviews
            .iter()
            .flat_map(|t| &t.anchor.ranges)
            .filter_map(|r| r.quote_hash.as_ref())
            .collect::<std::collections::BTreeSet<_>>()
        {
            self.read_object(hash)?;
        }
        scenesparrow_domain::planning::validate(
            root.planning
                .as_ref()
                .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?,
            false,
        )?;
        self.verify_sources(&root.sources)
            .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?;
        Ok(root)
    }
    pub(super) fn read_object(&self, digest: &str) -> Result<Vec<u8>> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(ManuscriptError("STORAGE_UNAVAILABLE", None));
        }
        db(crate::operation::read(
            &self.directory.join("objects").join(digest),
            digest,
        ))
    }
    fn verify_sources(&self, sources: &[Source]) -> Result<()> {
        let mut ids = BTreeSet::new();
        for s in sources {
            if !manuscript::uuid4(&s.id) || !ids.insert(&s.id) {
                return invalid();
            }
            match s.kind {
                SourceKind::Link => {
                    validate_url(s.url.as_deref().unwrap_or_default())?;
                    if s.object_hash.is_some() || s.evidence != SourceEvidence::Linkonly {
                        return invalid();
                    }
                }
                SourceKind::File => {
                    let bytes = self.read_object(s.object_hash.as_deref().unwrap_or_default())?;
                    if s.size != Some(bytes.len() as i64) || s.evidence != SourceEvidence::Filebytes
                    {
                        return invalid();
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn source_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        if let ManuscriptCommand::CommitManuscriptImport { payload, .. } = command {
            return self.import_transition(c, command, before, identities, payload);
        }
        let mut members = Self::source_members(c)?;
        let mut affected = BTreeSet::new();
        match command {
            ManuscriptCommand::AddSourceLink { payload, .. } => {
                validate_url(&payload.url)?;
                text_check(&payload.title, 1024)?;
                id_check(&payload.source_id)?;
                if identities.contains_key(&payload.source_id) {
                    return invalid();
                }
                affected.insert(payload.source_id.clone());
                members.push(Source {
                    id: payload.source_id.clone(),
                    revision: 1,
                    kind: SourceKind::Link,
                    title: payload.title.clone(),
                    url: Some(payload.url.clone()),
                    object_hash: None,
                    mime_type: None,
                    size: None,
                    evidence: SourceEvidence::Linkonly,
                    intake_id: None,
                });
            }
            ManuscriptCommand::AddSourceFile { payload, .. } => {
                id_check(&payload.source_id)?;
                if identities.contains_key(&payload.source_id) {
                    return invalid();
                }
                let intake = Self::intake(c, &payload.intake_id)?;
                if intake.hash != payload.hash {
                    return invalid();
                }
                self.read_object(&intake.hash)?;
                affected.insert(payload.source_id.clone());
                members.push(Source {
                    id: payload.source_id.clone(),
                    revision: 1,
                    kind: SourceKind::File,
                    title: intake.display_name,
                    url: None,
                    object_hash: Some(intake.hash),
                    mime_type: Some(intake.mime_type),
                    size: Some(intake.size),
                    evidence: SourceEvidence::Filebytes,
                    intake_id: Some(intake.id),
                });
            }
            ManuscriptCommand::RemoveSource { payload, .. } => {
                let s = members
                    .iter()
                    .find(|s| s.id == payload.source_id)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                if s.revision != payload.expected_source_revision {
                    return Err(ManuscriptError("REVISION_CONFLICT", None));
                }
                affected.insert(s.id.clone());
                members.retain(|s| s.id != payload.source_id);
            }
            _ => return invalid(),
        }
        members.sort_by(|a, b| a.id.cmp(&b.id));
        let mut state = before.clone();
        state.working_revision = manuscript::next_revision(before.working_revision)?;
        self.policy.validate(before, &state, &affected)?;
        Ok(Transition {
            locks: None,
            reviews: None,
            state,
            affected,
            normalized: false,
            sources: Some(members),
            planning: None,
            planning_metadata: None,
        })
    }
    fn import_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
        payload: &CommitManuscriptImportPayload,
    ) -> Result<Transition> {
        let job = self.job(c, &payload.prepared_id).map_err(|e| {
            if e.0 == "OBJECT_NOT_FOUND" {
                ManuscriptError("IMPORT_STALE", None)
            } else {
                e
            }
        })?;
        if job.purpose != DocumentJobPurpose::Import
            || job.status != DocumentJobStatus::Ready
            || job.base_revision != before.working_revision
            || job.candidate_hash.as_ref() != Some(&payload.candidate_hash)
        {
            return Err(ManuscriptError("IMPORT_STALE", None));
        }
        let result = job.result.ok_or(ManuscriptError("IMPORT_STALE", None))?;
        if result.blocks.is_empty() {
            return Err(ManuscriptError("SOURCE_TEXT_UNAVAILABLE", None));
        }
        let start = payload.mode == CommitManuscriptImportPayloadMode::Start;
        if start != (before.workspace_stage == ManuscriptStateWorkspaceStage::Outline) {
            return Err(ManuscriptError("IMPORT_STALE", None));
        }
        let blocks = result
            .blocks
            .into_iter()
            .map(|b| Block {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                kind: b.kind,
                attrs: b.attrs,
                runs: b.runs,
            })
            .collect();
        let _ = command;
        manuscript::import_candidate(
            before,
            blocks,
            payload.mode == CommitManuscriptImportPayloadMode::Append,
            identities,
            self.policy.as_ref(),
        )
    }

    pub(super) fn restore_sources(
        &self,
        c: &Connection,
        before: &ManuscriptState,
        t: &mut Transition,
        target: &BusinessSnapshot,
        identities: &BTreeMap<String, i64>,
    ) -> Result<()> {
        let old = Self::source_members(c)?;
        let mut members = target.sources.clone();
        for s in &mut members {
            let mut compare = s.clone();
            compare.revision = 0;
            if let Some(previous) = old.iter().find(|v| v.id == s.id) {
                let mut p = previous.clone();
                p.revision = 0;
                if p == compare {
                    s.revision = previous.revision;
                    continue;
                }
            }
            s.revision = manuscript::next_revision(*identities.get(&s.id).ok_or_else(|| {
                ManuscriptError::history_blocked("IDENTITY_MISSING", &t.affected)
            })?)?;
            t.affected.insert(s.id.clone());
        }
        for s in &old {
            if !members.iter().any(|v| v.id == s.id) {
                t.affected.insert(s.id.clone());
            }
        }
        t.sources = Some(members);
        self.policy
            .validate(before, &t.state, &t.affected)
            .map_err(|e| ManuscriptError::history_blocked(e.0, &t.affected))
    }
    pub(super) fn commit_sources(
        &self,
        c: &Connection,
        before: &[Source],
        t: &Transition,
    ) -> Result<()> {
        let Some(members) = &t.sources else {
            return Ok(());
        };
        db(c.execute("DELETE FROM sources", []))?;
        for s in members {
            db(c.execute(
                "INSERT INTO sources VALUES(?1,?2,?3)",
                params![s.id, s.revision, db(serde_json::to_string(s))?],
            ))?;
            db(c.execute("INSERT INTO object_identities VALUES(?1,'source',?2,0) ON CONFLICT(id) DO UPDATE SET high_water=excluded.high_water,tombstoned=0",params![s.id,s.revision]))?;
        }
        for s in before {
            if !members.iter().any(|v| v.id == s.id) {
                db(c.execute("UPDATE document_attempts SET status='interrupted',attempt=attempt+1,error='DOCUMENT_JOB_INTERRUPTED' WHERE source_id=?1 AND status IN ('queued','running')",[&s.id]))?;
            }
        }
        Ok(())
    }
    fn intake(c: &Connection, id: &str) -> Result<Intake> {
        id_check(id)?;
        db(c.query_row("SELECT object_hash,size,display_name,mime_type FROM intakes WHERE id=?1 AND status='complete'",[id],|r|Ok(Intake{id:id.into(),hash:r.get(0)?,size:r.get(1)?,display_name:r.get(2)?,mime_type:r.get(3)?})).optional())?.ok_or(ManuscriptError("OBJECT_NOT_FOUND",None))
    }
    fn job(&self, c: &Connection, id: &str) -> Result<DocumentJob> {
        id_check(id)?;
        let tuple=db(c.query_row("SELECT attempt,status,purpose,input_hash,base_revision,source_id,result_hash,candidate_hash,error FROM document_attempts WHERE id=?1",[id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,i64>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?))).optional())?.ok_or(ManuscriptError("OBJECT_NOT_FOUND",None))?;
        Ok(DocumentJob {
            id: id.into(),
            attempt: tuple.0,
            status: status(&tuple.1)?,
            purpose: db(serde_json::from_value(serde_json::json!(tuple.2)))?,
            input_hash: tuple.3,
            base_revision: tuple.4,
            source_id: tuple.5,
            result: tuple
                .6
                .map(|h| db(serde_json::from_slice(&self.read_object(&h)?)))
                .transpose()?,
            candidate_hash: tuple.7,
            error: tuple.8,
        })
    }
    fn emit_job(c: &Connection, id: &str) -> Result<()> {
        db(c.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES('','documentJob.changed',?1)",[serde_json::json!({"affectedIds":[id]}).to_string()]))?;
        db(c.execute("DELETE FROM project_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM project_events)",[]))?;
        Ok(())
    }
    pub(super) fn recover_documents(&self) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        // Validate all retained references before fencing abandoned work.
        let roots = self.retention_roots(&c)?;
        for h in &roots {
            self.read_object(h)?;
        }
        self.verify_sources(&Self::source_members(&c)?)?;
        let tx = db(c.transaction())?;
        db(tx.execute("UPDATE document_attempts SET status='interrupted',attempt=attempt+1,error='DOCUMENT_JOB_INTERRUPTED' WHERE status IN ('queued','running')",[]))?;
        db(tx.execute("UPDATE document_attempts SET status='cancelled',attempt=attempt+1 WHERE purpose='import' AND status='ready'",[]))?;
        db(tx.execute(
            "UPDATE intakes SET status='cancelled' WHERE status IN ('uploading','complete')",
            [],
        ))?;
        db(tx.commit())?;
        // Startup owns the project lock and has fenced every old utility/intake.
        // Reconcile only core-generated staging identities, never other files.
        for entry in db(std::fs::read_dir(self.directory.join("staging")))? {
            let entry = db(entry)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if db(entry.file_type())?.is_file()
                && (manuscript::uuid4(&name)
                    || name.strip_prefix("intake-").is_some_and(manuscript::uuid4))
            {
                db(std::fs::remove_file(entry.path()))?;
            }
        }
        Ok(())
    }
    pub fn run_document(&self, id: &str) -> Result<()> {
        self.run_document_with_limits(id, Duration::from_secs(60), 512 * 1024 * 1024)
    }
    pub fn run_document_with_limits(&self, id: &str, wall: Duration, memory: u64) -> Result<()> {
        let _worker = self.worker_guard();
        let (attempt, input, name) = {
            let mut c = db(self.connection.lock())?;
            let j = self.job(&c, id)?;
            if self.is_quiescing() {
                return Ok(());
            }
            if j.status != DocumentJobStatus::Queued {
                return Ok(());
            }
            let name: String = db(c.query_row(
                "SELECT display_name FROM document_attempts WHERE id=?1",
                [id],
                |r| r.get(0),
            ))?;
            self.read_object(&j.input_hash)?;
            let tx = db(c.transaction())?;
            db(tx.execute(
                "UPDATE document_attempts SET status='running' WHERE id=?1 AND status='queued'",
                [id],
            ))?;
            Self::emit_job(&tx, id)?;
            db(tx.commit())?;
            (j.attempt, j.input_hash, name)
        };
        crate::diagnostics::emit(crate::diagnostics::Event::WorkerStart);
        let entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../workers/document/src/entry.mjs");
        let mut command = Command::new("node");
        command.env_clear();
        for key in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let child = match command
            .arg("--max-old-space-size=384")
            .arg(entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return self.finish_job(id, attempt, Err("WORKER_UNAVAILABLE")),
        };
        let mut child = WorkerChild(child);
        let request = DocumentWorkerInput {
            version: 1,
            attempt,
            path: self
                .directory
                .join("objects")
                .join(input)
                .to_string_lossy()
                .into_owned(),
            name,
        };
        let written = child.stdin.take().is_some_and(|mut stdin| {
            stdin
                .write_all(
                    serde_json::to_string(&request)
                        .unwrap_or_default()
                        .as_bytes(),
                )
                .is_ok()
        });
        let stdout = child
            .stdout
            .take()
            .ok_or(ManuscriptError("WORKER_UNAVAILABLE", None))?;
        let reader = std::thread::spawn(move || {
            let mut bytes = vec![];
            stdout
                .take(MAX_RESULT + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let start = Instant::now();
        let mut failure = None;
        if !written {
            failure = Some("WORKER_UNAVAILABLE");
        }
        loop {
            if failure.is_some() {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            {
                let c = db(self.connection.lock())?;
                let j = self.job(&c, id)?;
                if j.attempt != attempt || j.status != DocumentJobStatus::Running {
                    failure = Some("DOCUMENT_JOB_INTERRUPTED");
                }
            }
            if start.elapsed() > wall {
                failure = Some("DOCUMENT_PARSE_TIMEOUT");
            }
            #[cfg(target_os = "linux")]
            if std::fs::read_to_string(format!("/proc/{}/status", child.id()))
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("VmRSS:"))
                        .and_then(|l| l.split_whitespace().nth(1))
                        .and_then(|n| n.parse::<u64>().ok())
                })
                .is_some_and(|kb| kb * 1024 > memory)
            {
                failure = Some("DOCUMENT_RESOURCE_LIMIT");
            }
            #[cfg(not(target_os = "linux"))]
            let _ = memory;
            match child.try_wait() {
                Ok(Some(exit)) => {
                    if !exit.success() {
                        failure = Some("DOCUMENT_RESOURCE_LIMIT");
                    }
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    failure = Some("WORKER_UNAVAILABLE");
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let bytes = reader.join().ok().and_then(|r| r.ok()).unwrap_or_default();
        if bytes.len() as u64 > MAX_RESULT {
            failure = Some("DOCUMENT_RESOURCE_LIMIT");
        }
        if let Some(code) = failure {
            return self.finish_job(id, attempt, Err(code));
        }
        let response: DocumentWorkerOutput = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return self.finish_job(id, attempt, Err("DOCUMENT_PARSE_FAILED")),
        };
        if response.version != 1 {
            return self.finish_job(id, attempt, Err("DOCUMENT_PARSE_FAILED"));
        }
        if let Some(code) = response.error {
            if response.result.is_some() {
                return self.finish_job(id, attempt, Err("DOCUMENT_PARSE_FAILED"));
            }
            let known = match code.as_str() {
                "TEXT_ENCODING_UNSUPPORTED" => "TEXT_ENCODING_UNSUPPORTED",
                "SOURCE_UNSUPPORTED" => "SOURCE_UNSUPPORTED",
                "SOURCE_ENCRYPTED" => "SOURCE_ENCRYPTED",
                "DOCUMENT_RESOURCE_LIMIT" => "DOCUMENT_RESOURCE_LIMIT",
                _ => "DOCUMENT_PARSE_FAILED",
            };
            return self.finish_job(id, attempt, Err(known));
        }
        if response.attempt != Some(attempt) {
            return self.finish_job(id, attempt, Err("DOCUMENT_JOB_INTERRUPTED"));
        }
        let Some(result) = response.result else {
            return self.finish_job(id, attempt, Err("DOCUMENT_PARSE_FAILED"));
        };
        self.finish_job(id, attempt, Ok(result))
    }
    fn finish_job(
        &self,
        id: &str,
        attempt: i64,
        result: std::result::Result<DocumentResult, &'static str>,
    ) -> Result<()> {
        crate::diagnostics::emit_record(
            crate::diagnostics::Event::WorkerResult,
            None,
            None,
            None,
            None,
            Some(result.is_ok()),
        );
        let mut c = db(self.connection.lock())?;
        let j = self.job(&c, id)?;
        if j.attempt != attempt || j.status != DocumentJobStatus::Running {
            return Ok(());
        }
        let mut error = None;
        let mut result_hash = None;
        let mut candidate = None;
        match result {
            Err(e) => error = Some(e),
            Ok(result) => {
                if result.text.len() > 10 * 1024 * 1024 {
                    error = Some("DOCUMENT_RESOURCE_LIMIT");
                } else {
                    if j.purpose == DocumentJobPurpose::Import {
                        let mut check = ManuscriptState {
                            manuscript_id: uuid::Uuid::new_v4().to_string(),
                            schema_version: 1,
                            workspace_stage: ManuscriptStateWorkspaceStage::Draft,
                            working_revision: 0,
                            blocks: result
                                .blocks
                                .iter()
                                .map(|b| Block {
                                    id: b.id.clone(),
                                    revision: 1,
                                    kind: b.kind.clone(),
                                    attrs: b.attrs.clone(),
                                    runs: b.runs.clone(),
                                })
                                .collect(),
                        };
                        if result.text.trim().is_empty() {
                            error = Some("SOURCE_TEXT_UNAVAILABLE");
                        } else if let Err(e) = manuscript::normalize(&mut check) {
                            error = Some(if e.0 == "DOCUMENT_TOO_LARGE" {
                                "DOCUMENT_TOO_LARGE"
                            } else {
                                "DOCUMENT_INVALID"
                            });
                        } else {
                            candidate = Some(hash(&db(serde_json::to_vec(&result.blocks))?));
                        }
                    } else if result.text.trim().is_empty() {
                        error = Some("SOURCE_TEXT_UNAVAILABLE");
                    }
                    result_hash = Some(self.object(&db(serde_json::to_vec(&result))?)?);
                }
            }
        }
        let tx = db(c.transaction())?;
        db(tx.execute("UPDATE document_attempts SET status=?3,result_hash=?4,candidate_hash=?5,error=?6 WHERE id=?1 AND attempt=?2 AND status='running'",params![id,attempt,if error.is_some(){"failed"}else{"ready"},result_hash,candidate,error]))?;
        Self::emit_job(&tx, id)?;
        db(tx.commit())?;
        Ok(())
    }
    /// Future artifacts pin verified immutable payloads by identity, never by path.
    pub fn pin_object(&self, owner: &str, digest: &str) -> Result<()> {
        id_check(owner)?;
        let c = db(self.connection.lock())?;
        self.read_object(digest)?;
        db(c.execute(
            "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
            params![owner, digest],
        ))?;
        Ok(())
    }
    pub fn unpin_objects(&self, owner: &str) -> Result<()> {
        id_check(owner)?;
        let c = db(self.connection.lock())?;
        db(c.execute(
            "DELETE FROM external_object_pins WHERE owner_id=?1",
            [owner],
        ))?;
        Ok(())
    }
    pub fn collect_objects(&self, grace: Duration) -> Result<usize> {
        // Capture, reconciliation, row pruning and deletion share the exact writer
        // coordinator used by promotion and command commit. Backups are not traversed.
        let mut c = db(self.connection.lock())?;
        let roots = self.retention_roots(&c)?;
        for h in &roots {
            self.read_object(h)?;
        }
        let mut candidates = vec![];
        for entry in db(std::fs::read_dir(self.directory.join("objects")))? {
            let entry = db(entry)?;
            let h = entry.file_name().to_string_lossy().into_owned();
            if !roots.contains(&h)
                && db(entry.file_type())?.is_file()
                && db(entry.metadata())?
                    .modified()
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age >= grace)
            {
                candidates.push((h, entry.path()));
            }
        }
        let tx = db(c.transaction())?;
        for (h, _) in &candidates {
            db(tx.execute("DELETE FROM content_revisions WHERE payload_hash=?1", [h]))?;
            db(tx.execute(
                "DELETE FROM import_provenance WHERE input_hash=?1 OR result_hash=?1",
                [h],
            ))?;
            db(tx.execute("DELETE FROM document_attempts WHERE status NOT IN ('queued','running') AND (input_hash=?1 OR result_hash=?1)",[h]))?;
        }
        db(tx.commit())?;
        // A failure after metadata pruning leaves harmless orphan bytes. Never unlink
        // first: rollback must not restore a committed row pointing to deleted bytes.
        let mut removed = 0;
        for (_, path) in candidates {
            db(std::fs::remove_file(path))?;
            removed += 1;
        }
        Ok(removed)
    }
}
struct WorkerChild(std::process::Child);
impl std::ops::Deref for WorkerChild {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for WorkerChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for WorkerChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn validate_url(text: &str) -> Result<()> {
    text_check(text, 8192)?;
    if text.chars().any(char::is_control) {
        return Err(ManuscriptError("INVALID_URL", None));
    }
    let url = url::Url::parse(text).map_err(|_| ManuscriptError("INVALID_URL", None))?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(ManuscriptError("INVALID_URL", None));
    }
    Ok(())
}
impl DocumentRepository for SqliteProjectRepository {
    fn read_sources(&self, after: Option<&str>) -> Result<SourcePage> {
        if let Some(id) = after {
            id_check(id)?;
        }
        let c = db(self.connection.lock())?;
        let members = Self::source_members(&c)?;
        let mut items = vec![];
        for s in members
            .into_iter()
            .filter(|s| after.is_none_or(|a| s.id.as_str() > a))
            .take(101)
        {
            let jid:Option<String>=db(c.query_row("SELECT id FROM document_attempts WHERE source_id=?1 ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 0 WHEN 'ready' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,rowid DESC LIMIT 1",[&s.id],|r|r.get(0)).optional())?;
            let job = jid.as_ref().map(|id| self.job(&c, id)).transpose()?;
            let status = if s.kind == SourceKind::Link {
                "link_only"
            } else {
                match job.as_ref().map(|j| &j.status) {
                    Some(DocumentJobStatus::Ready) => "ready",
                    Some(DocumentJobStatus::Failed) => "failed",
                    Some(DocumentJobStatus::Running) => "running",
                    Some(DocumentJobStatus::Queued) => "queued",
                    _ => "interrupted",
                }
            };
            items.push(SourceSummary {
                source: s,
                job_id: jid,
                status: db(serde_json::from_value(serde_json::json!(status)))?,
                error: job.as_ref().and_then(|j| j.error.clone()),
                warnings: job
                    .as_ref()
                    .and_then(|j| j.result.as_ref())
                    .map(|r| r.warnings.clone())
                    .unwrap_or_default(),
                has_images: job
                    .as_ref()
                    .and_then(|j| j.result.as_ref())
                    .is_some_and(|r| r.has_images),
            });
        }
        let next = if items.len() > 100 {
            items.truncate(100);
            items.last().map(|s| s.source.id.clone())
        } else {
            None
        };
        Ok(SourcePage { items, next })
    }
    fn begin_intake(&self, id: &str, name: &str, mime: &str) -> Result<()> {
        id_check(id)?;
        text_check(name, 1024)?;
        text_check(mime, 256)?;
        if name.trim().is_empty() || name.contains(['/', '\\']) {
            return invalid();
        }
        let mut c = db(self.connection.lock())?;
        if read_project(&c)
            .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?
            .is_none()
        {
            return Err(ManuscriptError("PROJECT_NOT_FOUND", None));
        }
        if db(c
            .query_row("SELECT 1 FROM intakes WHERE id=?1", [id], |_| Ok(()))
            .optional())?
        .is_some()
        {
            return Err(ManuscriptError("REQUEST_ID_CONFLICT", None));
        }
        let path = self.directory.join("staging").join(format!("intake-{id}"));
        let file = db(File::options().create_new(true).write(true).open(&path))?;
        db(file.sync_all())?;
        let tx = db(c.transaction())?;
        db(tx.execute(
            "INSERT INTO intakes VALUES(?1,?2,?3,0,NULL,'uploading')",
            params![id, name, mime],
        ))?;
        db(tx.commit())?;
        Ok(())
    }
    fn append_intake(&self, id: &str, bytes: &[u8]) -> Result<()> {
        id_check(id)?;
        let c = db(self.connection.lock())?;
        let uploading = db(c
            .query_row(
                "SELECT 1 FROM intakes WHERE id=?1 AND status='uploading'",
                [id],
                |_| Ok(()),
            )
            .optional())?
        .is_some();
        if !uploading {
            return Err(ManuscriptError("OBJECT_NOT_FOUND", None));
        }
        let path = self.directory.join("staging").join(format!("intake-{id}"));
        let mut f = db(File::options().append(true).open(&path))?;
        let size = db(f.metadata())?.len();
        if size + bytes.len() as u64 > MAX_INPUT {
            return Err(ManuscriptError("INPUT_TOO_LARGE", None));
        }
        db(f.write_all(bytes))?;
        Ok(())
    }
    fn complete_intake(&self, id: &str) -> Result<Intake> {
        id_check(id)?;
        let mut c = db(self.connection.lock())?;
        if let Ok(i) = Self::intake(&c, id) {
            return Ok(i);
        }
        if db(c
            .query_row(
                "SELECT 1 FROM intakes WHERE id=?1 AND status='uploading'",
                [id],
                |_| Ok(()),
            )
            .optional())?
        .is_none()
        {
            return Err(ManuscriptError("OBJECT_NOT_FOUND", None));
        }
        let path = self.directory.join("staging").join(format!("intake-{id}"));
        let mut f = db(File::options().read(true).write(true).open(&path))?;
        db(f.sync_all())?;
        let mut bytes = vec![];
        db((&mut f).take(MAX_INPUT + 1).read_to_end(&mut bytes))?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err(ManuscriptError("INPUT_TOO_LARGE", None));
        }
        let digest = self.object(&bytes)?;
        let tx = db(c.transaction())?;
        db(tx.execute("UPDATE intakes SET status='complete',size=?2,object_hash=?3 WHERE id=?1 AND status='uploading'",params![id,bytes.len() as i64,digest]))?;
        db(tx.commit())?;
        drop(f);
        db(std::fs::remove_file(path))?;
        Self::intake(&c, id)
    }
    fn read_intake(&self, id: &str) -> Result<Intake> {
        let c = db(self.connection.lock())?;
        Self::intake(&c, id)
    }
    fn cancel_intake(&self, id: &str) -> Result<()> {
        id_check(id)?;
        let c = db(self.connection.lock())?;
        db(c.execute(
            "UPDATE intakes SET status='cancelled',object_hash=NULL WHERE id=?1",
            [id],
        ))?;
        let path = self.directory.join("staging").join(format!("intake-{id}"));
        if path.exists() {
            db(std::fs::remove_file(path))?;
        }
        Ok(())
    }
    fn document_action(&self, action: &DocumentAction) -> Result<DocumentJob> {
        let mut c = db(self.connection.lock())?;
        let id = match action {
            DocumentAction::PrepareFile { job_id, .. }
            | DocumentAction::PreparePaste { job_id, .. }
            | DocumentAction::ExtractSource { job_id, .. }
            | DocumentAction::Cancel { job_id } => job_id,
        };
        id_check(id)?;
        if let DocumentAction::Cancel { .. } = action {
            let tx = db(c.transaction())?;
            db(tx.execute("UPDATE document_attempts SET status='cancelled',attempt=attempt+1 WHERE id=?1 AND status NOT IN ('cancelled')",[id]))?;
            Self::emit_job(&tx, id)?;
            db(tx.commit())?;
            return self.job(&c, id);
        }
        if db(c
            .query_row("SELECT 1 FROM object_identities WHERE id=?1", [id], |_| {
                Ok(())
            })
            .optional())?
        .is_some()
            || self.job(&c, id).is_ok()
        {
            return Err(ManuscriptError("REQUEST_ID_CONFLICT", None));
        }
        let revision: i64 = db(c
            .query_row("SELECT working_revision FROM manuscripts", [], |r| r.get(0))
            .optional())?
        .ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?;
        let count: i64 = db(c.query_row(
            "SELECT COUNT(*) FROM document_attempts WHERE status IN ('queued','running')",
            [],
            |r| r.get(0),
        ))?;
        if count >= 16 {
            return Err(ManuscriptError("WORKER_UNAVAILABLE", None));
        }
        let (input, name, source, purpose) = match action {
            DocumentAction::PrepareFile {
                intake_id,
                expected_working_revision,
                ..
            } => {
                if *expected_working_revision != revision {
                    return Err(ManuscriptError("IMPORT_STALE", None));
                }
                let i = Self::intake(&c, intake_id)?;
                (i.hash, i.display_name, None, "import")
            }
            DocumentAction::PreparePaste {
                text,
                expected_working_revision,
                ..
            } => {
                if *expected_working_revision != revision {
                    return Err(ManuscriptError("IMPORT_STALE", None));
                }
                if text.len() > manuscript::MAX_TEXT_BYTES {
                    return Err(ManuscriptError("DOCUMENT_TOO_LARGE", None));
                }
                (
                    self.object(text.as_bytes())?,
                    "paste.txt".into(),
                    None,
                    "import",
                )
            }
            DocumentAction::ExtractSource { source_id, .. } => {
                let s = Self::source_members(&c)?
                    .into_iter()
                    .find(|s| s.id == *source_id)
                    .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
                if s.kind != SourceKind::File {
                    return invalid();
                }
                let running=db(c.query_row("SELECT 1 FROM document_attempts WHERE source_id=?1 AND status IN ('queued','running')",[source_id],|_|Ok(())).optional())?.is_some();
                if running {
                    return Err(ManuscriptError("INVALID_REQUEST", None));
                }
                (
                    s.object_hash
                        .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?,
                    s.title,
                    Some(source_id.clone()),
                    "source",
                )
            }
            _ => return invalid(),
        };
        self.read_object(&input)?;
        let tx = db(c.transaction())?;
        db(tx.execute(
            "INSERT INTO object_identities VALUES(?1,'document_job',1,0)",
            [id],
        ))?;
        db(tx.execute("INSERT INTO document_attempts(id,attempt,status,purpose,input_hash,display_name,base_revision,source_id) VALUES(?1,1,'queued',?2,?3,?4,?5,?6)",params![id,purpose,input,name,revision,source]))?;
        Self::emit_job(&tx, id)?;
        if let DocumentAction::PrepareFile { intake_id, .. } = action {
            db(tx.execute(
                "UPDATE intakes SET status='cancelled',object_hash=NULL WHERE id=?1",
                [intake_id],
            ))?;
        }
        db(tx.commit())?;
        self.job(&c, id)
    }
    fn document_job(&self, id: &str) -> Result<DocumentJob> {
        let c = db(self.connection.lock())?;
        self.job(&c, id)
    }
    fn extraction_page(&self, id: &str, offset: usize) -> Result<ExtractionPage> {
        let c = db(self.connection.lock())?;
        let job = self.job(&c, id)?;
        if job.purpose != DocumentJobPurpose::Source
            || !Self::source_members(&c)?
                .iter()
                .any(|s| Some(&s.id) == job.source_id.as_ref())
        {
            return Err(ManuscriptError("OBJECT_NOT_FOUND", None));
        }
        let r = job
            .result
            .ok_or(ManuscriptError("SOURCE_TEXT_UNAVAILABLE", None))?;
        if offset > r.text.len() || !r.text.is_char_boundary(offset) {
            return invalid();
        }
        let mut end = (offset + 65536).min(r.text.len());
        while !r.text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(ExtractionPage {
            job_id: id.into(),
            text: r.text[offset..end].into(),
            offset: offset as i64,
            next: if end < r.text.len() {
                Some(end as i64)
            } else {
                None
            },
            warnings: r.warnings,
            references: r.references,
            has_images: r.has_images,
            parser: r.parser,
        })
    }
    fn events(&self, after: i64) -> Result<EventPage> {
        if !(0..=manuscript::MAX_REVISION).contains(&after) {
            return invalid();
        }
        let c = db(self.connection.lock())?;
        let project = read_project(&c)
            .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?
            .ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?;
        let (min, max): (i64, i64) = db(c.query_row(
            "SELECT COALESCE(MIN(sequence),0),COALESCE(MAX(sequence),0) FROM project_events",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))?;
        let resync = after > max || (after < min - 1);
        let mut events = vec![];
        if !resync {
            let mut stmt=db(c.prepare("SELECT sequence,event_type,request_id,payload_json FROM project_events WHERE sequence>?1 ORDER BY sequence LIMIT 1000"))?;
            for row in db(stmt.query_map([after], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            }))? {
                let (sequence, kind, request_id, payload) = db(row)?;
                let p: serde_json::Value = db(serde_json::from_str(&payload))?;
                events.push(ProjectEvent {
                    sequence,
                    project_id: project.id.clone(),
                    r#type: db(serde_json::from_value(serde_json::json!(kind)))?,
                    request_id: request_id.filter(|v| !v.is_empty()),
                    working_revision: p
                        .get("workingRevision")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(project.working_revision),
                    affected_ids: p
                        .get("affectedIds")
                        .map(|v| db(serde_json::from_value(v.clone())))
                        .transpose()?
                        .unwrap_or_default(),
                });
            }
        }
        Ok(EventPage {
            events,
            latest: max,
            resync_required: resync,
        })
    }
}

#[cfg(test)]
#[path = "documents_tests.rs"]
mod tests;

#[cfg(test)]
impl SqliteProjectRepository {
    pub(crate) fn finish_document_fixture(
        &self,
        id: &str,
        attempt: i64,
        result: std::result::Result<DocumentResult, &'static str>,
    ) -> Result<()> {
        {
            let c = db(self.connection.lock())?;
            db(c.execute("UPDATE document_attempts SET status='running' WHERE id=?1 AND status='queued' AND attempt=?2",params![id,attempt]))?;
        }
        self.finish_job(id, attempt, result)
    }
}
