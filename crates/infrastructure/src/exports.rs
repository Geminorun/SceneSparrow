use super::storage::{Result, db, hash};
use super::*;
use crate::worker_process::{self, WorkerChild};
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, ManuscriptError},
};
use std::{
    io::{Read, Write},
    time::Instant,
};

fn err(code: &'static str) -> ManuscriptError {
    ManuscriptError(code, None)
}
fn value<T: serde::de::DeserializeOwned>(s: &str) -> Result<T> {
    db(serde_json::from_value(serde_json::json!(s)))
}
fn format(f: &ExportRequestFormat) -> &'static str {
    match f {
        ExportRequestFormat::Txt => "txt",
        ExportRequestFormat::Md => "md",
        ExportRequestFormat::Docx => "docx",
    }
}
fn check(id: &str) -> Result<()> {
    if manuscript::uuid4(id) {
        Ok(())
    } else {
        Err(err("INVALID_REQUEST"))
    }
}
fn emit(c: &Connection, id: &str) -> Result<()> {
    db(c.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES('','exportJob.changed',?1)",[serde_json::json!({"affectedIds":[id]}).to_string()]))?;
    db(c.execute("DELETE FROM project_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM project_events)",[]))?;
    Ok(())
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn namespace_conflict(c: &Connection, id: &str, kind: &str) -> Result<bool> {
    let export: bool = db(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM export_jobs WHERE id=?1)",
        [id],
        |r| r.get(0),
    ))?;
    let control: bool = db(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM export_controls WHERE request_id=?1)",
        [id],
        |r| r.get(0),
    ))?;
    let copy: bool = db(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM copy_preparations WHERE id=?1)",
        [id],
        |r| r.get(0),
    ))?;
    Ok(match kind {
        "export" => control || copy,
        "control" => export || copy,
        "copy" => export || control,
        _ => true,
    })
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn reserved_name(name: &str) -> bool {
    let name = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(['.', ' '])
        .to_uppercase();
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].contains(&name.as_str())
        || ["COM", "LPT"].iter().any(|prefix| {
            name.strip_prefix(prefix).is_some_and(|suffix| {
                suffix.chars().count() == 1 && suffix.chars().all(|c| "123456789¹²³".contains(c))
            })
        })
}
fn valid_filename(name: &str, format: &str) -> bool {
    let Some(base) = name.strip_suffix(&std::format!(".{format}")) else {
        return false;
    };
    !base.is_empty()
        && base.len() <= 180
        && base.encode_utf16().count() <= 120
        && base.trim_end_matches(['.', ' ']) == base
        && !base
            .chars()
            .any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
        && !reserved_name(base)
}
pub(super) fn read_job(c: &Connection, id: &str) -> Result<ExportJob> {
    if !manuscript::uuid4(id) {
        return Err(err("PROJECT_INTEGRITY_FAILED"));
    }
    let job=db(c.query_row("SELECT format,status,attempt,snapshot_hash,body_hash,captured_revision,filename,artifact_hash,size,error,input_retained,captured_baseline,retain_until FROM export_jobs WHERE id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<String>>(7)?,r.get::<_,i64>(8)?,r.get::<_,Option<String>>(9)?,r.get::<_,i64>(10)?,r.get::<_,Option<String>>(11)?,r.get::<_,i64>(12)?))).optional())?.ok_or(err("OBJECT_NOT_FOUND"))?;
    if !(1..=manuscript::MAX_REVISION).contains(&job.2)
        || !(0..=manuscript::MAX_REVISION).contains(&job.5)
        || !(0..=32 * 1024 * 1024).contains(&job.8)
        || !valid_hash(&job.3)
        || !valid_hash(&job.4)
        || job.7.as_deref().is_some_and(|h| !valid_hash(h))
        || !valid_filename(&job.6, &job.0)
        || ![0, 1].contains(&job.10)
        || !(0..=manuscript::MAX_REVISION).contains(&job.12)
        || job.11.as_deref().is_some_and(|id| !manuscript::uuid4(id))
        || job.9.as_deref().is_some_and(|e| {
            ![
                "EXPORT_INVALID",
                "EXPORT_TOO_LARGE",
                "EXPORT_FAILED",
                "EXPORT_INTERRUPTED",
                "WORKER_UNAVAILABLE",
            ]
            .contains(&e)
        })
    {
        return Err(err("PROJECT_INTEGRITY_FAILED"));
    }
    let status: ExportJobStatus = value(&job.1)?;
    if status == ExportJobStatus::Ready && (job.7.is_none() || job.8 == 0 || job.10 != 0) {
        return Err(err("PROJECT_INTEGRITY_FAILED"));
    }
    let delivery=db(c.query_row("SELECT delivery_id,artifact_hash,status,error FROM export_deliveries WHERE job_id=?1 ORDER BY rowid DESC LIMIT 1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?))).optional())?.map(|(delivery_id,artifact_hash,status,error)|{
        if !manuscript::uuid4(&delivery_id) || !valid_hash(&artifact_hash) || job.7.as_ref()!=Some(&artifact_hash){return Err(err("PROJECT_INTEGRITY_FAILED"));}
        Ok(DeliveryReceipt{delivery_id,job_id:id.into(),artifact_hash,status:value(&status)?,error})
    }).transpose()?;
    let input_retained = job.10 == 1
        && (!matches!(
            status,
            ExportJobStatus::Failed | ExportJobStatus::Interrupted
        ) || job.12 >= now_ms());
    Ok(ExportJob {
        id: id.into(),
        delivery,
        format: value(&job.0)?,
        status,
        attempt: job.2,
        snapshot_hash: job.3,
        body_hash: job.4,
        captured_revision: job.5,
        filename: job.6,
        artifact_hash: job.7,
        size: job.8,
        error: job.9,
        input_retained,
        serializer_version: "canonical-1".into(),
        captured_finalized: job.11.is_some(),
        captured_baseline: job.11,
    })
}

impl SqliteProjectRepository {
    pub fn read_exports(&self) -> Result<Vec<ExportJob>> {
        let c = db(self.connection.lock())?;
        let mut q = db(c.prepare("SELECT id FROM export_jobs ORDER BY rowid DESC LIMIT 30"))?;
        db(q.query_map([], |r| r.get::<_, String>(0)))?
            .map(|id| read_job(&c, &db(id)?))
            .collect()
    }
    pub fn export_job(&self, id: &str) -> Result<ExportJob> {
        check(id)?;
        let c = db(self.connection.lock())?;
        read_job(&c, id)
    }
    pub fn start_export(&self, r: &ExportRequest) -> Result<ExportJob> {
        check(&r.request_id)?;
        let digest = hash(&db(serde_json::to_vec(r))?);
        self.start_export_digest(r, &digest, None)
    }
    fn start_export_digest(
        &self,
        r: &ExportRequest,
        digest: &str,
        retire: Option<(&str, i64)>,
    ) -> Result<ExportJob> {
        let mut c = db(self.connection.lock())?;
        if let Some(previous) = db(c
            .query_row(
                "SELECT request_digest FROM export_jobs WHERE id=?1",
                [&r.request_id],
                |row| row.get::<_, String>(0),
            )
            .optional())?
        {
            return if previous == digest {
                read_job(&c, &r.request_id)
            } else {
                Err(err("INVALID_REQUEST"))
            };
        }
        if namespace_conflict(&c, &r.request_id, "export")? {
            return Err(err("INVALID_REQUEST"));
        }
        if let Some((id, attempt)) = retire {
            let old = read_job(&c, id)?;
            if old.attempt != attempt
                || !matches!(
                    old.status,
                    ExportJobStatus::Failed
                        | ExportJobStatus::Interrupted
                        | ExportJobStatus::Cancelled
                )
            {
                return Err(err("INVALID_RETRY"));
            }
        }
        if self.quiescing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(err("EXPORT_INTERRUPTED"));
        }
        let queued: i64 = db(c.query_row(
            "SELECT COUNT(*) FROM export_jobs WHERE status='queued'",
            [],
            |r| r.get(0),
        ))?;
        if queued >= 4 {
            return Err(err("QUEUE_FULL"));
        }
        let state = self.load(&c)?;
        let body_hash = hash(scenesparrow_domain::exports::body_token(&state).as_bytes());
        if r.expected_body_hash
            .as_ref()
            .map_or(state.working_revision != r.expected_revision, |expected| {
                expected != &body_hash
            })
        {
            return Err(err("REVISION_CONFLICT"));
        }
        if state.workspace_stage != ManuscriptStateWorkspaceStage::Draft {
            return Err(err("STAGE_CONFLICT"));
        }
        if !state
            .blocks
            .iter()
            .flat_map(|b| &b.runs)
            .any(|r| !r.text.trim().is_empty())
        {
            return Err(err("NO_MANUSCRIPT_CONTENT"));
        }
        // Body identity deliberately excludes the global business sequence and approval metadata.
        let snapshot = serde_json::json!({"version":1,"manuscriptId":state.manuscript_id,"schemaVersion":state.schema_version,"blocks":state.blocks});
        let bytes = db(serde_json::to_vec(&snapshot))?;
        let snapshot_hash = self.object(&bytes)?;
        let baseline: Option<String> = db(c.query_row(
            "SELECT baseline_id FROM manuscript_baseline",
            [],
            |r| r.get(0),
        ))?;
        let title = read_project(&c)
            .map_err(|_| err("STORAGE_UNAVAILABLE"))?
            .ok_or(err("PROJECT_NOT_FOUND"))?
            .title;
        // The utility supplies the grapheme-safe suggestion. This conservative core name
        // remains safe even when a caller does not use the platform's display helper.
        let name = title
            .chars()
            .filter(|ch| !ch.is_control() && !"/\\<>:\"|?*".contains(*ch))
            .collect::<String>();
        let name = name.trim().trim_end_matches(['.', ' ']);
        let name = if name.is_empty() || reserved_name(name) {
            "manuscript"
        } else {
            name
        };
        let mut bounded = String::new();
        for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(name, true) {
            if bounded.len() + grapheme.len() > 180
                || bounded.encode_utf16().count() + grapheme.encode_utf16().count() > 120
            {
                break;
            }
            bounded.push_str(grapheme);
        }
        let bounded = bounded.trim_end_matches(['.', ' ']);
        let name = if bounded.is_empty() || reserved_name(bounded) {
            "manuscript"
        } else {
            bounded
        };
        let filename = std::format!("{}.{}", name, format(&r.format));
        let tx = db(c.transaction())?;
        db(tx.execute("INSERT INTO export_jobs(id,request_digest,format,status,attempt,snapshot_hash,body_hash,captured_revision,filename,captured_baseline) VALUES(?1,?2,?3,'queued',1,?4,?5,?6,?7,?8)",params![r.request_id,digest,format(&r.format),snapshot_hash,body_hash,state.working_revision,filename,baseline]))?;
        db(tx.execute(
            "INSERT INTO external_object_pins VALUES(?1,?2)",
            params![std::format!("export:{}", r.request_id), snapshot_hash],
        ))?;
        if let Some((id, _)) = retire {
            db(tx.execute("UPDATE export_jobs SET input_retained=0 WHERE id=?1", [id]))?;
            db(tx.execute(
                "DELETE FROM external_object_pins WHERE owner_id=?1",
                [std::format!("export:{id}")],
            ))?;
            emit(&tx, id)?;
        }
        emit(&tx, &r.request_id)?;
        db(tx.commit())?;
        read_job(&c, &r.request_id)
    }
    pub fn cancel_export(&self, id: &str, r: &ExportControl) -> Result<ExportJob> {
        check(id)?;
        check(&r.request_id)?;
        let mut c = db(self.connection.lock())?;
        let digest = hash(&db(serde_json::to_vec(&("cancel", id, r)))?);
        if let Some((d, j)) = db(c
            .query_row(
                "SELECT digest,job_id FROM export_controls WHERE request_id=?1",
                [&r.request_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional())?
        {
            return if d == digest {
                read_job(&c, &j)
            } else {
                Err(err("INVALID_REQUEST"))
            };
        }
        if namespace_conflict(&c, &r.request_id, "control")? {
            return Err(err("INVALID_REQUEST"));
        }
        let current = read_job(&c, id)?;
        if current.status == ExportJobStatus::Ready {
            db(c.execute(
                "INSERT INTO export_controls VALUES(?1,?2,?3)",
                params![r.request_id, digest, id],
            ))?;
            return Ok(current);
        }
        if current.attempt != r.attempt {
            return Err(err("REVISION_CONFLICT"));
        }
        let tx = db(c.transaction())?;
        db(tx.execute("UPDATE export_jobs SET status='cancelled',attempt=attempt+1,input_retained=0 WHERE id=?1 AND status IN ('queued','running','failed','interrupted')",[id]))?;
        db(tx.execute(
            "DELETE FROM external_object_pins WHERE owner_id=?1",
            [std::format!("export:{id}")],
        ))?;
        db(tx.execute(
            "INSERT INTO export_controls VALUES(?1,?2,?3)",
            params![r.request_id, digest, id],
        ))?;
        emit(&tx, id)?;
        db(tx.commit())?;
        read_job(&c, id)
    }
    pub fn retry_export(&self, id: &str, r: &ExportRetry) -> Result<ExportJob> {
        check(id)?;
        check(&r.request_id)?;
        if r.mode == ExportRetryMode::Recapture {
            let digest = hash(&db(serde_json::to_vec(&("recapture", id, r)))?);
            {
                let c = db(self.connection.lock())?;
                if let Some(d) = db(c
                    .query_row(
                        "SELECT request_digest FROM export_jobs WHERE id=?1",
                        [&r.request_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional())?
                {
                    return if d == digest {
                        read_job(&c, &r.request_id)
                    } else {
                        Err(err("INVALID_REQUEST"))
                    };
                }
            }
            {
                let c = db(self.connection.lock())?;
                if namespace_conflict(&c, &r.request_id, "export")? {
                    return Err(err("INVALID_REQUEST"));
                }
            }
            let old = self.export_job(id)?;
            if old.attempt != r.attempt
                || !matches!(
                    old.status,
                    ExportJobStatus::Failed
                        | ExportJobStatus::Interrupted
                        | ExportJobStatus::Cancelled
                )
            {
                return Err(err("INVALID_RETRY"));
            }
            return self.start_export_digest(
                &ExportRequest {
                    request_id: r.request_id.clone(),
                    expected_revision: r.expected_revision,
                    expected_body_hash: r.expected_body_hash.clone(),
                    format: value(match old.format {
                        ExportJobFormat::Txt => "txt",
                        ExportJobFormat::Md => "md",
                        ExportJobFormat::Docx => "docx",
                    })?,
                },
                &digest,
                Some((id, r.attempt)),
            );
        }
        let mut c = db(self.connection.lock())?;
        let digest = hash(&db(serde_json::to_vec(&("retry", id, r)))?);
        if let Some((d, j)) = db(c
            .query_row(
                "SELECT digest,job_id FROM export_controls WHERE request_id=?1",
                [&r.request_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional())?
        {
            return if d == digest {
                read_job(&c, &j)
            } else {
                Err(err("INVALID_REQUEST"))
            };
        }
        if namespace_conflict(&c, &r.request_id, "control")? {
            return Err(err("INVALID_REQUEST"));
        }
        let current = read_job(&c, id)?;
        if current.attempt != r.attempt
            || !matches!(
                current.status,
                ExportJobStatus::Failed | ExportJobStatus::Interrupted
            )
            || !current.input_retained
        {
            return Err(err("INVALID_RETRY"));
        }
        self.read_object(&current.snapshot_hash)?;
        if db(c.query_row(
            "SELECT COUNT(*) FROM export_jobs WHERE status='queued'",
            [],
            |r| r.get::<_, i64>(0),
        ))? >= 4
        {
            return Err(err("QUEUE_FULL"));
        }
        let tx = db(c.transaction())?;
        db(tx.execute(
            "UPDATE export_jobs SET status='queued',attempt=attempt+1,error=NULL WHERE id=?1",
            [id],
        ))?;
        db(tx.execute(
            "INSERT INTO export_controls VALUES(?1,?2,?3)",
            params![r.request_id, digest, id],
        ))?;
        emit(&tx, id)?;
        db(tx.commit())?;
        read_job(&c, id)
    }
    pub fn next_export(&self) -> Result<Option<String>> {
        if self.quiescing.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(None);
        }
        let c = db(self.connection.lock())?;
        if db(c.query_row(
            "SELECT COUNT(*) FROM export_jobs WHERE status='running'",
            [],
            |r| r.get::<_, i64>(0),
        ))? > 0
        {
            return Ok(None);
        }
        let id: Option<String> = db(c
            .query_row(
                "SELECT id FROM export_jobs WHERE status='queued' ORDER BY rowid LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(id) = &id {
            read_job(&c, id)?;
        }
        Ok(id)
    }
    pub fn export_bytes(&self, id: &str) -> Result<(ExportJob, Vec<u8>)> {
        check(id)?;
        let c = db(self.connection.lock())?;
        let j = read_job(&c, id)?;
        if j.status != ExportJobStatus::Ready {
            return Err(err("RESULT_UNAVAILABLE"));
        }
        let bytes = db(std::fs::read(self.directory.join("exports").join(id)))?;
        if bytes.len() as i64 != j.size || j.artifact_hash.as_deref() != Some(hash(&bytes).as_str())
        {
            return Err(err("PROJECT_INTEGRITY_FAILED"));
        }
        Ok((j, bytes))
    }
    pub fn run_export(&self, id: &str) -> Result<()> {
        self.run_export_at(id, None, Duration::from_secs(60), 512 * 1024 * 1024)
    }
    fn run_export_at(
        &self,
        id: &str,
        entry: Option<&Path>,
        wall: Duration,
        memory: u64,
    ) -> Result<()> {
        let _worker = self.worker_guard();
        let current = {
            let mut c = db(self.connection.lock())?;
            if self.is_quiescing() {
                return Ok(());
            }
            let current = read_job(&c, id)?;
            if current.status != ExportJobStatus::Queued {
                return Ok(());
            }
            if db(c.query_row(
                "SELECT COUNT(*) FROM export_jobs WHERE status='running'",
                [],
                |r| r.get::<_, i64>(0),
            ))? > 0
            {
                return Ok(());
            }
            let tx = db(c.transaction())?;
            db(tx.execute("UPDATE export_jobs SET status='running' WHERE id=?1", [id]))?;
            emit(&tx, id)?;
            db(tx.commit())?;
            current
        };
        if self.read_object(&current.snapshot_hash).is_err() {
            return self.finish_export(id, current.attempt, Err("EXPORT_INVALID"));
        }
        let start = Instant::now();
        let staging = self
            .directory
            .join("staging")
            .join(std::format!("export-{id}-{}", current.attempt));
        crate::diagnostics::emit(crate::diagnostics::Event::WorkerStart);
        let input = self.directory.join("objects").join(&current.snapshot_hash);
        let child =
            worker_process::document_command(&entry.map(Path::to_path_buf).unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../workers/document/src/export-entry.mjs")
            }))
            .spawn();
        let Ok(child) = child else {
            return self.finish_export(id, current.attempt, Err("WORKER_UNAVAILABLE"));
        };
        let mut child = WorkerChild(child);
        let request = serde_json::json!({"version":1,"attempt":current.attempt,"format":current.format,"input":input,"expectedHash":current.snapshot_hash,"output":staging});
        let stdin = child.0.stdin.take();
        let writer = std::thread::spawn(move || {
            stdin.is_some_and(|mut s| s.write_all(request.to_string().as_bytes()).is_ok())
        });
        let stdout = child.0.stdout.take().ok_or(err("WORKER_UNAVAILABLE"))?;
        let reader = std::thread::spawn(move || {
            let mut bytes = vec![];
            stdout.take(16385).read_to_end(&mut bytes).map(|_| bytes)
        });
        let mut failure = None;
        #[cfg(not(target_os = "linux"))]
        let _ = memory;
        loop {
            if self.quiescing.load(std::sync::atomic::Ordering::Acquire) {
                failure = Some("EXPORT_INTERRUPTED");
            }
            {
                let c = db(self.connection.lock())?;
                let j = read_job(&c, id)?;
                if j.attempt != current.attempt || j.status != ExportJobStatus::Running {
                    failure = Some("EXPORT_INTERRUPTED");
                }
            }
            if start.elapsed() > wall {
                failure = Some("EXPORT_INTERRUPTED");
            }
            #[cfg(target_os = "linux")]
            if worker_process::resident_kib(child.0.id())
                .is_some_and(|kb| kb.saturating_mul(1024) > memory)
            {
                failure = Some("EXPORT_TOO_LARGE");
            }
            if failure.is_some() {
                let _ = child.0.kill();
                let _ = child.0.wait();
                break;
            }
            match child.0.try_wait() {
                Ok(Some(exit)) => {
                    if !exit.success() {
                        failure = Some("EXPORT_FAILED");
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
        if writer.join().ok() != Some(true) {
            failure = Some("WORKER_UNAVAILABLE");
        }
        let output = reader.join().ok().and_then(|r| r.ok()).unwrap_or_default();
        let envelope: serde_json::Value = serde_json::from_slice(&output).unwrap_or_default();
        if envelope["attempt"].as_i64() != Some(current.attempt) || envelope["version"] != 1 {
            failure.get_or_insert("EXPORT_INVALID");
        }
        let result = if let Some(code) = failure {
            Err(code)
        } else {
            self.validate_export_file(&staging, &current)
                .map_err(|e| e.0)
        };
        let result = match result {
            Ok(bytes) => Ok(bytes),
            Err(e) => {
                let _ = std::fs::remove_file(&staging);
                return self.finish_export(id, current.attempt, Err(e));
            }
        };
        // Promotion metadata is persisted before rename. Startup can verify/reconcile a
        // completed promotion, but cannot manufacture missing output from input caches.
        self.finish_export(id, current.attempt, result)
    }
    fn validate_export_file(&self, path: &Path, j: &ExportJob) -> Result<Vec<u8>> {
        let meta = db(std::fs::symlink_metadata(path))?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > 32 * 1024 * 1024 {
            return Err(err("EXPORT_TOO_LARGE"));
        }
        let bytes = db(std::fs::read(path))?;
        match j.format {
            ExportJobFormat::Docx => validate_docx(&bytes)?,
            _ => {
                let s = std::str::from_utf8(&bytes).map_err(|_| err("EXPORT_INVALID"))?;
                if !s.ends_with('\n') || s.contains('\r') {
                    return Err(err("EXPORT_INVALID"));
                }
            }
        }
        Ok(bytes)
    }
    fn finish_export(
        &self,
        id: &str,
        attempt: i64,
        result: std::result::Result<Vec<u8>, &'static str>,
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
        let j = read_job(&c, id)?;
        if j.attempt != attempt || j.status != ExportJobStatus::Running {
            let _ = std::fs::remove_file(
                self.directory
                    .join("staging")
                    .join(std::format!("export-{id}-{attempt}")),
            );
            return Ok(());
        }
        let tx = db(c.transaction())?;
        match result {
            Ok(bytes) => {
                let digest = hash(&bytes);
                let staging = self
                    .directory
                    .join("staging")
                    .join(std::format!("export-{id}-{attempt}"));
                db(tx.execute(
                    "UPDATE export_jobs SET artifact_hash=?2,size=?3 WHERE id=?1",
                    params![id, digest, bytes.len() as i64],
                ))?;
                // This intent is durable before filesystem promotion.
                db(tx.commit())?;
                let promoted = (|| -> Result<()> {
                    db(std::fs::rename(
                        &staging,
                        self.directory.join("exports").join(id),
                    ))?;
                    #[cfg(test)]
                    if self
                        .fail_export_directory_sync
                        .swap(false, std::sync::atomic::Ordering::AcqRel)
                    {
                        return Err(err("EXPORT_INTERRUPTED"));
                    }
                    #[cfg(unix)]
                    db(File::open(self.directory.join("exports")).and_then(|f| f.sync_all()))?;
                    Ok(())
                })();
                if promoted.is_err() {
                    // A failed rename still owns this staging file. A successful
                    // rename followed by failed directory sync has no temp left.
                    let _ = std::fs::remove_file(&staging);
                    let tx = db(c.transaction())?;
                    db(tx.execute("UPDATE export_jobs SET status='interrupted',error='EXPORT_INTERRUPTED' WHERE id=?1",[id]))?;
                    emit(&tx, id)?;
                    db(tx.commit())?;
                    return Ok(());
                }
                let tx = db(c.transaction())?;
                db(tx.execute("UPDATE export_jobs SET status='ready',input_retained=0,error=NULL WHERE id=?1 AND attempt=?2 AND status='running'",params![id,attempt]))?;
                db(tx.execute(
                    "DELETE FROM external_object_pins WHERE owner_id=?1",
                    [std::format!("export:{id}")],
                ))?;
                emit(&tx, id)?;
                db(tx.commit())?;
            }
            Err(code) => {
                db(tx.execute(
                    "UPDATE export_jobs SET status=?3,error=?4 WHERE id=?1 AND attempt=?2",
                    params![
                        id,
                        attempt,
                        if code == "EXPORT_INTERRUPTED" {
                            "interrupted"
                        } else {
                            "failed"
                        },
                        code
                    ],
                ))?;
                emit(&tx, id)?;
                db(tx.commit())?;
            }
        }
        Ok(())
    }
    pub(super) fn recover_exports(&self) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        db(c.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT 'copy:'||id FROM copy_preparations WHERE expires_at<?1)",[now]))?;
        db(c.execute(
            "UPDATE copy_preparations SET payload_hash=NULL WHERE expires_at<?1",
            [now],
        ))?;
        let ids = {
            let mut s = db(c.prepare("SELECT id FROM export_jobs"))?;
            db(s.query_map([], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        for id in ids {
            let j = read_job(&c, &id)?;
            let path = self.directory.join("exports").join(&id);
            if j.status == ExportJobStatus::Ready
                || (matches!(
                    j.status,
                    ExportJobStatus::Running | ExportJobStatus::Interrupted
                ) && j.artifact_hash.is_some()
                    && path.exists())
            {
                let bytes = self.validate_export_file(&path, &j)?;
                if j.artifact_hash.as_deref() != Some(hash(&bytes).as_str())
                    || j.size != bytes.len() as i64
                {
                    return Err(err("PROJECT_INTEGRITY_FAILED"));
                }
                #[cfg(unix)]
                db(File::open(self.directory.join("exports")).and_then(|f| f.sync_all()))?;
                let tx = db(c.transaction())?;
                db(tx.execute(
                    "UPDATE export_jobs SET status='ready',input_retained=0,error=NULL WHERE id=?1",
                    [&id],
                ))?;
                db(tx.execute(
                    "DELETE FROM external_object_pins WHERE owner_id=?1",
                    [std::format!("export:{id}")],
                ))?;
                db(tx.commit())?;
            } else if j.status == ExportJobStatus::Running {
                db(c.execute("UPDATE export_jobs SET status='interrupted',attempt=attempt+1,error='EXPORT_INTERRUPTED' WHERE id=?1",[&id]))?;
            }
        }
        db(c.execute("UPDATE export_deliveries SET status='unknown',error='DELIVERY_STATUS_UNKNOWN' WHERE status='intent'",[]))?;
        self.cleanup_export_staging(&c)?;
        Ok(())
    }
    pub fn delivery_receipt(
        &self,
        a: &DeliveryAction,
        finish: Option<&str>,
    ) -> Result<DeliveryReceipt> {
        check(&a.delivery_id)?;
        check(&a.job_id)?;
        let mut c = db(self.connection.lock())?;
        let previous=db(c.query_row("SELECT job_id,artifact_hash,status,error FROM export_deliveries WHERE delivery_id=?1",[&a.delivery_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?))).optional())?;
        if let Some((jid, h, s, e)) = previous {
            if jid != a.job_id || h != a.artifact_hash {
                return Err(err("INVALID_REQUEST"));
            }
            if let Some(status) = finish
                && s == "intent"
                && ["saved", "unknown", "failed"].contains(&status)
            {
                db(c.execute(
                    "UPDATE export_deliveries SET status=?2 WHERE delivery_id=?1",
                    params![a.delivery_id, status],
                ))?;
                return Ok(DeliveryReceipt {
                    delivery_id: a.delivery_id.clone(),
                    job_id: jid,
                    artifact_hash: h,
                    status: value(status)?,
                    error: None,
                });
            }
            return Ok(DeliveryReceipt {
                delivery_id: a.delivery_id.clone(),
                job_id: jid,
                artifact_hash: h,
                status: value(&s)?,
                error: e,
            });
        }
        if finish.is_some() {
            return Err(err("INVALID_REQUEST"));
        }
        let j = read_job(&c, &a.job_id)?;
        if j.status != ExportJobStatus::Ready || j.artifact_hash.as_ref() != Some(&a.artifact_hash)
        {
            return Err(err("ARTIFACT_MISMATCH"));
        }
        let tx = db(c.transaction())?;
        db(tx.execute(
            "INSERT INTO export_deliveries VALUES(?1,?2,?3,'intent',NULL)",
            params![a.delivery_id, a.job_id, a.artifact_hash],
        ))?;
        db(tx.commit())?;
        Ok(DeliveryReceipt {
            delivery_id: a.delivery_id.clone(),
            job_id: a.job_id.clone(),
            artifact_hash: a.artifact_hash.clone(),
            status: DeliveryReceiptStatus::Intent,
            error: None,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
    use serde_json::json;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn cmd(
        repo: &SqliteProjectRepository,
        kind: &str,
        payload: serde_json::Value,
    ) -> CommandReceipt {
        let state = repo.read_manuscript().unwrap();
        let p = repo.read().unwrap().unwrap();
        repo.execute_manuscript(&serde_json::from_value(json!({"type":kind,"requestId":id(),"projectId":p.id,"expectedWorkingRevision":state.working_revision,"payload":payload})).unwrap()).unwrap()
    }
    pub(super) fn setup() -> (tempfile::TempDir, SqliteProjectRepository) {
        let d = tempfile::tempdir().unwrap();
        let r = SqliteProjectRepository::open(d.path()).unwrap();
        r.create("create", "中文 👩‍💻 export").unwrap();
        cmd(&r, "StartManualDraft", json!({}));
        edit(&r, "中文 👩‍💻 é 🔒 literal comment");
        (d, r)
    }
    pub(super) fn edit(r: &SqliteProjectRepository, text: &str) {
        let state = r.read_manuscript().unwrap();
        let b = state.blocks.first();
        let ops = if let Some(b) = b {
            json!([{"op":"setBlockContent","id":b.id,"runs":[{"text":text,"marks":[]}]}])
        } else {
            json!([{"op":"insertBlock","after":null,"block":{"id":id(),"kind":"paragraph","attrs":{},"runs":[{"text":text,"marks":[]}]}}])
        };
        cmd(
            r,
            "ApplyDocumentEdit",
            json!({"operations":ops,"expectedBlockRevisions":state.blocks.iter().map(|b|json!({"id":b.id,"revision":b.revision})).collect::<Vec<_>>(),"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}),
        );
    }
    pub(super) fn start(r: &SqliteProjectRepository, f: &str) -> ExportJob {
        r.start_export(&ExportRequest {
            request_id: id(),
            expected_revision: r.read_manuscript().unwrap().working_revision,
            expected_body_hash: None,
            format: value(f).unwrap(),
        })
        .unwrap()
    }
    #[test]
    fn capture_is_pinned_outside_history_and_exact_replay_precedes_revision_and_queue() {
        let (_d, r) = setup();
        let before = r.read_history().unwrap();
        let first = start(&r, "txt");
        edit(&r, "new body after capture");
        r.collect_objects(Duration::ZERO).unwrap();
        assert!(r.read_object(&first.snapshot_hash).is_ok());
        let replay = ExportRequest {
            request_id: first.id.clone(),
            expected_revision: first.captured_revision,
            expected_body_hash: None,
            format: ExportRequestFormat::Txt,
        };
        assert_eq!(r.start_export(&replay).unwrap(), first);
        let mut altered = replay.clone();
        altered.format = ExportRequestFormat::Md;
        assert_eq!(r.start_export(&altered).unwrap_err().0, "INVALID_REQUEST");
        let history = r.read_history().unwrap();
        assert_eq!(history.undo_count, before.undo_count + 1);
        r.run_export(&first.id).unwrap();
        let (ready, bytes) = r.export_bytes(&first.id).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "中文 👩‍💻 é 🔒 literal comment\n"
        );
        assert!(!ready.input_retained);
        assert_eq!(r.read_history().unwrap(), history);
        let cancelled = r
            .cancel_export(
                &first.id,
                &ExportControl {
                    request_id: id(),
                    attempt: first.attempt,
                },
            )
            .unwrap();
        assert_eq!(cancelled.status, ExportJobStatus::Ready);
        assert!(
            r.retained_object_roots()
                .unwrap()
                .iter()
                .all(|h| h != &first.snapshot_hash)
        );
    }
    #[test]
    fn body_identity_ignores_locks_but_not_actual_block_tokens_and_formats_survive_reopen() {
        let (d, r) = setup();
        let first = start(&r, "txt");
        r.run_export(&first.id).unwrap();
        cmd(
            &r,
            "SetUserLocks",
            json!({"locked":true,"all":true,"blockIds":[]}),
        );
        let second = start(&r, "md");
        assert_eq!(first.body_hash, second.body_hash);
        assert_ne!(first.captured_revision, second.captured_revision);
        r.run_export(&second.id).unwrap();
        let docx = start(&r, "docx");
        r.run_export(&docx.id).unwrap();
        assert!(r.export_bytes(&docx.id).unwrap().1.starts_with(b"PK"));
        drop(r);
        let reopened = SqliteProjectRepository::open(d.path()).unwrap();
        assert_eq!(
            reopened.export_job(&second.id).unwrap().status,
            ExportJobStatus::Ready
        );
        assert_eq!(
            reopened.export_bytes(&first.id).unwrap().1,
            "中文 👩‍💻 é 🔒 literal comment\n".as_bytes()
        );
    }
    #[test]
    fn cancellation_fences_attempt_retry_is_explicit_and_queue_is_bounded() {
        let (_d, r) = setup();
        let first = start(&r, "txt");
        for _ in 0..3 {
            start(&r, "txt");
        }
        assert_eq!(
            r.start_export(&ExportRequest {
                request_id: id(),
                expected_revision: 2,
                expected_body_hash: None,
                format: ExportRequestFormat::Txt
            })
            .unwrap_err()
            .0,
            "QUEUE_FULL"
        );
        let control = ExportControl {
            request_id: id(),
            attempt: first.attempt,
        };
        let cancelled = r.cancel_export(&first.id, &control).unwrap();
        assert_eq!(cancelled.status, ExportJobStatus::Cancelled);
        assert_eq!(r.cancel_export(&first.id, &control).unwrap(), cancelled);
        r.run_export(&first.id).unwrap();
        assert_eq!(
            r.export_job(&first.id).unwrap().status,
            ExportJobStatus::Cancelled
        );
        assert_eq!(
            r.retry_export(
                &first.id,
                &ExportRetry {
                    request_id: id(),
                    attempt: cancelled.attempt,
                    mode: ExportRetryMode::Retained,
                    expected_body_hash: None,
                    expected_revision: 2
                }
            )
            .unwrap_err()
            .0,
            "INVALID_RETRY"
        );
    }
    #[test]
    fn promotion_registration_crash_and_external_delivery_intent_recover_without_replay() {
        let (d, r) = setup();
        let j = start(&r, "txt");
        let bytes = b"captured\n";
        std::fs::write(d.path().join("exports").join(&j.id), bytes).unwrap();
        {
            let c = r.connection.lock().unwrap();
            c.execute(
                "UPDATE export_jobs SET status='running',artifact_hash=?2,size=?3 WHERE id=?1",
                params![j.id, hash(bytes), bytes.len() as i64],
            )
            .unwrap();
        }
        drop(r);
        let r = SqliteProjectRepository::open(d.path()).unwrap();
        let recovered = r.export_job(&j.id).unwrap();
        assert_eq!(recovered.status, ExportJobStatus::Ready);
        let action = DeliveryAction {
            delivery_id: id(),
            job_id: j.id.clone(),
            artifact_hash: recovered.artifact_hash.unwrap(),
        };
        assert_eq!(
            r.delivery_receipt(&action, None).unwrap().status,
            DeliveryReceiptStatus::Intent
        );
        drop(r);
        let r = SqliteProjectRepository::open(d.path()).unwrap();
        assert_eq!(
            r.delivery_receipt(&action, None).unwrap().status,
            DeliveryReceiptStatus::Unknown
        );
        assert_eq!(
            r.read_exports().unwrap()[0]
                .delivery
                .as_ref()
                .unwrap()
                .status,
            DeliveryReceiptStatus::Unknown
        );
        assert_eq!(
            r.delivery_receipt(&action, Some("saved")).unwrap().status,
            DeliveryReceiptStatus::Unknown
        );
    }
    #[test]
    fn verified_backup_restores_new_copy_with_exact_history_locks_and_artifacts_and_rejects_corruption()
     {
        let (d, r) = setup();
        edit(&r, "second");
        let j = start(&r, "md");
        r.run_export(&j.id).unwrap();
        cmd(
            &r,
            "SetUserLocks",
            json!({"locked":true,"all":true,"blockIds":[]}),
        );
        let state = r.read_manuscript().unwrap();
        let history = r.read_history().unwrap();
        let backup = r.verified_backup().unwrap();
        let target = d.path().join("recovered-copy");
        let copy = SqliteProjectRepository::restore_verified_copy(&backup, &target).unwrap();
        assert_eq!(copy.read_manuscript().unwrap(), state);
        assert_eq!(copy.read_history().unwrap(), history);
        assert_eq!(
            copy.export_bytes(&j.id).unwrap().1,
            r.export_bytes(&j.id).unwrap().1
        );
        drop(copy);
        std::fs::write(backup.join("exports").join(&j.id), b"corrupt").unwrap();
        assert!(
            SqliteProjectRepository::restore_verified_copy(&backup, &d.path().join("invalid-copy"))
                .is_err()
        );
        assert!(!d.path().join("invalid-copy").exists());
        assert_eq!(r.read_manuscript().unwrap(), state);
    }
}
impl SqliteProjectRepository {
    pub fn prepare_copy(&self, r: &CopyRequest) -> Result<PreparedCopy> {
        check(&r.request_id)?;
        let digest = hash(&db(serde_json::to_vec(r))?);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let mut c = db(self.connection.lock())?;
        if let Some(previous) = db(c
            .query_row(
                "SELECT digest FROM copy_preparations WHERE id=?1",
                [&r.request_id],
                |row| row.get::<_, String>(0),
            )
            .optional())?
        {
            if previous != digest {
                return Err(err("INVALID_REQUEST"));
            }
            let (input, payload, expires): (String, Option<String>, i64) = db(c.query_row(
                "SELECT snapshot_hash,payload_hash,expires_at FROM copy_preparations WHERE id=?1",
                [&r.request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ))?;
            if expires < now {
                return Err(err("CAPABILITY_EXPIRED"));
            }
            if payload.is_some() {
                return self.copy_locked(&c, &r.request_id, now);
            }
            let blocks: Vec<Block> = db(serde_json::from_slice(&self.read_object(&input)?))?;
            drop(c);
            return self.finish_copy(&r.request_id, &blocks, now);
        }
        if namespace_conflict(&c, &r.request_id, "copy")? {
            return Err(err("INVALID_REQUEST"));
        }
        let state = self.load(&c)?;
        let body_hash = hash(scenesparrow_domain::exports::body_token(&state).as_bytes());
        if body_hash != r.expected_body_hash {
            return Err(err("REVISION_CONFLICT"));
        }
        if state.workspace_stage != ManuscriptStateWorkspaceStage::Draft {
            return Err(err("STAGE_CONFLICT"));
        }
        if !state
            .blocks
            .iter()
            .flat_map(|b| &b.runs)
            .any(|r| !r.text.trim().is_empty())
        {
            return Err(err("NO_MANUSCRIPT_CONTENT"));
        }
        let expires_at = now + 600_000;
        // TXT needs no utility job or retained generated file. Its bounded canonical
        // serializer runs outside SQL while this short-lived preparation owns pins.
        let input = self.object(&db(serde_json::to_vec(&state.blocks))?)?;
        let tx = db(c.transaction())?;
        db(tx.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT 'copy:'||id FROM copy_preparations WHERE expires_at<?1)",[now]))?;
        db(tx.execute(
            "UPDATE copy_preparations SET payload_hash=NULL WHERE expires_at<?1",
            [now],
        ))?;
        if db(tx.query_row(
            "SELECT COUNT(*) FROM copy_preparations WHERE expires_at>=?1",
            [now],
            |row| row.get::<_, i64>(0),
        ))? >= 8
        {
            return Err(err("QUEUE_FULL"));
        }
        db(tx.execute(
            "INSERT INTO copy_preparations VALUES(?1,?2,?3,?4,?5,NULL,?6)",
            params![
                r.request_id,
                digest,
                input,
                body_hash,
                state.working_revision,
                expires_at
            ],
        ))?;
        db(tx.execute(
            "INSERT INTO external_object_pins VALUES(?1,?2)",
            params![std::format!("copy:{}", r.request_id), input],
        ))?;
        db(tx.commit())?;
        drop(c);
        self.finish_copy(&r.request_id, &state.blocks, now)
    }
    fn finish_copy(&self, id: &str, blocks: &[Block], now: i64) -> Result<PreparedCopy> {
        let text = scenesparrow_domain::exports::plain(blocks);
        let mut c = db(self.connection.lock())?;
        let payload = self.object(text.as_bytes())?;
        let tx = db(c.transaction())?;
        db(tx.execute(
            "UPDATE copy_preparations SET payload_hash=?2 WHERE id=?1",
            params![id, payload],
        ))?;
        db(tx.execute(
            "DELETE FROM external_object_pins WHERE owner_id=?1",
            [std::format!("copy:{}", id)],
        ))?;
        db(tx.execute(
            "INSERT INTO external_object_pins VALUES(?1,?2)",
            params![std::format!("copy:{}", id), payload],
        ))?;
        db(tx.commit())?;
        self.copy_locked(&c, id, now)
    }
    fn copy_locked(&self, c: &Connection, id: &str, now: i64) -> Result<PreparedCopy> {
        let (body_hash,captured_revision,payload,expires_at):(String,i64,Option<String>,i64)=db(c.query_row("SELECT body_hash,captured_revision,payload_hash,expires_at FROM copy_preparations WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional())?.ok_or(err("CAPABILITY_EXPIRED"))?;
        if expires_at < now {
            return Err(err("CAPABILITY_EXPIRED"));
        }
        let text = String::from_utf8(
            self.read_object(payload.as_deref().ok_or(err("COMMAND_UNRESOLVED"))?)?,
        )
        .map_err(|_| err("PROJECT_INTEGRITY_FAILED"))?;
        Ok(PreparedCopy {
            id: id.into(),
            body_hash,
            captured_revision,
            text,
            expires_at,
        })
    }
    pub fn prepared_copy(&self, id: &str) -> Result<PreparedCopy> {
        check(id)?;
        let c = db(self.connection.lock())?;
        self.copy_locked(
            &c,
            id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
        )
    }
}

fn validate_docx(bytes: &[u8]) -> Result<()> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| err("EXPORT_INVALID"))?;
    if archive.len() > 1024 {
        return Err(err("EXPORT_INVALID"));
    }
    let mut total = 0u64;
    let mut names = std::collections::BTreeSet::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| err("EXPORT_INVALID"))?;
        let name = entry.name().to_owned();
        if !names.insert(name.clone())
            || entry.enclosed_name().is_none()
            || name.to_lowercase().contains("vbaproject")
            || name.starts_with("customXml/")
        {
            return Err(err("EXPORT_INVALID"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or(err("EXPORT_TOO_LARGE"))?;
        if total > 100 * 1024 * 1024 {
            return Err(err("EXPORT_TOO_LARGE"));
        }
        let mut data = vec![];
        entry
            .by_ref()
            .take(100 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| err("EXPORT_INVALID"))?;
        if data.len() as u64 != entry.size() {
            return Err(err("EXPORT_INVALID"));
        }
        if name.ends_with(".xml") || name.ends_with(".rels") {
            let mut reader = quick_xml::Reader::from_reader(data.as_slice());
            loop {
                match reader.read_event() {
                    Ok(quick_xml::events::Event::Eof) => break,
                    Ok(quick_xml::events::Event::DocType(_)) | Err(_) => {
                        return Err(err("EXPORT_INVALID"));
                    }
                    Ok(quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e))
                        if [
                            b"w:comment".as_slice(),
                            b"w:commentRangeStart",
                            b"w:ins",
                            b"w:del",
                            b"w:attachedTemplate",
                        ]
                        .contains(&e.name().as_ref()) =>
                    {
                        return Err(err("EXPORT_INVALID"));
                    }
                    _ => {}
                }
            }
        }
    }
    for required in [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
        "word/numbering.xml",
        "docProps/core.xml",
    ] {
        if !names.contains(required) {
            return Err(err("EXPORT_INVALID"));
        }
    }
    Ok(())
}
#[cfg(test)]
mod fault_tests {
    use super::*;
    use scenesparrow_application::{
        ProjectRepository,
        manuscript::{DocumentRepository, ManuscriptRepository},
    };
    use serde_json::json;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn setup() -> (tempfile::TempDir, SqliteProjectRepository) {
        let d = tempfile::tempdir().unwrap();
        let r = SqliteProjectRepository::open(d.path()).unwrap();
        let p = r.create("create", "fault").unwrap();
        let command = |kind, payload| {
            serde_json::from_value(json!({"type":kind,"requestId":id(),"projectId":p.id,"expectedWorkingRevision":if kind=="StartManualDraft"{0}else{1},"payload":payload})).unwrap()
        };
        r.execute_manuscript(&command("StartManualDraft", json!({})))
            .unwrap();
        r.execute_manuscript(&command("ApplyDocumentEdit",json!({"operations":[{"op":"insertBlock","after":null,"block":{"id":id(),"kind":"paragraph","attrs":{},"runs":[{"text":"body 中文", "marks":[]}]}}],"expectedBlockRevisions":[],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap();
        (d, r)
    }
    #[test]
    fn copy_preparation_has_no_job_or_history_and_replays_after_local_promotion_loss() {
        let (d, r) = setup();
        let state = r.read_manuscript().unwrap();
        let history = r.read_history().unwrap();
        let req = CopyRequest {
            request_id: id(),
            expected_revision: state.working_revision,
            expected_body_hash: hash(scenesparrow_domain::exports::body_token(&state).as_bytes()),
        };
        let copy = r.prepare_copy(&req).unwrap();
        assert_eq!(copy.text, "body 中文\n");
        assert!(r.read_exports().unwrap().is_empty());
        assert_eq!(r.read_history().unwrap(), history);
        {
            let c = r.connection.lock().unwrap();
            let input = r
                .object(&serde_json::to_vec(&state.blocks).unwrap())
                .unwrap();
            c.execute(
                "UPDATE copy_preparations SET payload_hash=NULL,snapshot_hash=?2 WHERE id=?1",
                params![req.request_id, input],
            )
            .unwrap();
            c.execute(
                "UPDATE external_object_pins SET object_hash=?2 WHERE owner_id=?1",
                params![format!("copy:{}", req.request_id), input],
            )
            .unwrap();
        }
        drop(r);
        let r = SqliteProjectRepository::open(d.path()).unwrap();
        assert_eq!(r.prepare_copy(&req).unwrap(), copy);
        let mut altered = req;
        altered.expected_body_hash = "other".into();
        assert_eq!(r.prepare_copy(&altered).unwrap_err().0, "INVALID_REQUEST");
    }
    #[test]
    fn corrupted_captured_input_and_fake_docx_never_become_ready_or_silently_repair() {
        let (d, r) = setup();
        let j = r
            .start_export(&ExportRequest {
                request_id: id(),
                expected_revision: 2,
                expected_body_hash: None,
                format: ExportRequestFormat::Md,
            })
            .unwrap();
        std::fs::write(
            d.path().join("objects").join(&j.snapshot_hash),
            b"{\"version\":1,\"blocks\":[]}",
        )
        .unwrap();
        r.run_export(&j.id).unwrap();
        assert_eq!(r.export_job(&j.id).unwrap().status, ExportJobStatus::Failed);
        assert_eq!(
            r.export_job(&j.id).unwrap().error.as_deref(),
            Some("EXPORT_INVALID")
        );
        assert!(r.export_bytes(&j.id).is_err());
        assert!(validate_docx(b"PK\x03\x04fake truncated output").is_err());
    }
    #[test]
    fn ready_cancel_receipt_identity_is_bound_and_event_pages_decode_export_variant() {
        let (_d, r) = setup();
        let make = || {
            r.start_export(&ExportRequest {
                request_id: id(),
                expected_revision: 2,
                expected_body_hash: None,
                format: ExportRequestFormat::Txt,
            })
            .unwrap()
        };
        let ready = make();
        r.run_export(&ready.id).unwrap();
        let queued = make();
        let control = ExportControl {
            request_id: id(),
            attempt: ready.attempt,
        };
        assert_eq!(
            r.cancel_export(&ready.id, &control).unwrap().status,
            ExportJobStatus::Ready
        );
        assert_eq!(
            r.cancel_export(&queued.id, &control).unwrap_err().0,
            "INVALID_REQUEST"
        );
        assert_eq!(
            r.export_job(&queued.id).unwrap().status,
            ExportJobStatus::Queued
        );
        let events = r.events(0).unwrap();
        assert!(
            events
                .events
                .iter()
                .any(|e| serde_json::to_value(&e.r#type).unwrap() == "exportJob.changed")
        );
    }
}

impl SqliteProjectRepository {
    pub(crate) fn verify_export_records(&self, c: &Connection) -> Result<()> {
        let ids = {
            let mut q = db(c.prepare("SELECT id FROM export_jobs"))?;
            db(q.query_map([], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        for id in ids {
            let job = read_job(c, &id)?;
            if job.input_retained {
                self.read_object(&job.snapshot_hash)?;
            }
            if job.status == ExportJobStatus::Ready {
                let bytes =
                    self.validate_export_file(&self.directory.join("exports").join(&job.id), &job)?;
                if job.artifact_hash.as_deref() != Some(hash(&bytes).as_str())
                    || bytes.len() as i64 != job.size
                {
                    return Err(err("PROJECT_INTEGRITY_FAILED"));
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod path_tests {
    use super::*;
    use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
    #[test]
    fn stored_absolute_and_traversal_job_ids_are_rejected_before_inspection_recovery_or_dispatch() {
        for relative in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let outside = directory.path().join("outside-canary");
            std::fs::write(&outside, b"unchanged outside").unwrap();
            let project = directory.path().join("project");
            let repo = SqliteProjectRepository::open(&project).unwrap();
            repo.create("create", "security").unwrap();
            let state = repo.read_manuscript().unwrap();
            let snapshot=repo.object(&serde_json::to_vec(&serde_json::json!({"version":1,"manuscriptId":state.manuscript_id,"schemaVersion":1,"blocks":[]})).unwrap()).unwrap();
            let crafted = if relative {
                "../../outside-canary".into()
            } else {
                outside.to_string_lossy().into_owned()
            };
            {
                let c = repo.connection.lock().unwrap();
                c.execute("INSERT INTO export_jobs(id,request_digest,format,status,attempt,snapshot_hash,body_hash,captured_revision,filename) VALUES(?1,?2,'txt','queued',1,?2,?2,0,'safe.txt')",params![crafted,snapshot]).unwrap();
            }
            assert!(repo.next_export().is_err());
            assert!(repo.run_export(&crafted).is_err());
            assert!(repo.export_bytes(&crafted).is_err());
            drop(repo);
            assert!(SqliteProjectRepository::inspect_project(&project).is_err());
            assert!(SqliteProjectRepository::open(&project).is_err());
            assert_eq!(std::fs::read(&outside).unwrap(), b"unchanged outside");
        }
    }
}
impl SqliteProjectRepository {
    pub fn manuscript_identity(&self) -> Result<ManuscriptIdentity> {
        let c = db(self.connection.lock())?;
        let (id,schema,revision,stage):(String,i64,i64,String)=db(c.query_row("SELECT id,schema_version,working_revision,workspace_stage FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))))?;
        let mut q = db(c.prepare("SELECT id,revision FROM blocks ORDER BY position"))?;
        let tokens = db(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))))?
            .map(|row| {
                let (id, revision) = db(row)?;
                if !manuscript::uuid4(&id) || !(1..=manuscript::MAX_REVISION).contains(&revision) {
                    return Err(err("PROJECT_INTEGRITY_FAILED"));
                }
                Ok(std::format!("{id}:{revision}"))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ManuscriptIdentity {
            working_revision: revision,
            body_hash: hash(
                std::format!("canonical-1|{id}|{schema}|{}", tokens.join("|")).as_bytes(),
            ),
            workspace_stage: value(&stage)?,
        })
    }
}

impl SqliteProjectRepository {
    fn cleanup_export_staging(&self, c: &Connection) -> Result<()> {
        let folder = self.directory.join("staging");
        let metadata = db(std::fs::symlink_metadata(&folder))?;
        if !metadata.is_dir() {
            return Err(err("PROJECT_INTEGRITY_FAILED"));
        }
        for entry in db(std::fs::read_dir(&folder))? {
            let entry = db(entry)?;
            let name = entry.file_name();
            let Some((id, attempt)) = name
                .to_str()
                .and_then(|s| s.strip_prefix("export-"))
                .and_then(|s| s.rsplit_once('-'))
            else {
                continue;
            };
            if !manuscript::uuid4(id) {
                continue;
            }
            let Ok(attempt) = attempt.parse::<i64>() else {
                continue;
            };
            if !(1..=manuscript::MAX_REVISION).contains(&attempt) {
                continue;
            }
            let registered: bool = db(c.query_row(
                "SELECT EXISTS(SELECT 1 FROM export_jobs WHERE id=?1)",
                [id],
                |r| r.get(0),
            ))?;
            if !registered {
                continue;
            }
            let job = read_job(c, id)?;
            if attempt <= job.attempt
                && (attempt < job.attempt || job.status != ExportJobStatus::Running)
                && db(entry.file_type())?.is_file()
            {
                db(std::fs::remove_file(entry.path()))?;
            }
        }
        Ok(())
    }
    pub fn prune_export_inputs(&self) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        let now = now_ms();
        let tx = db(c.transaction())?;
        db(tx.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT 'copy:'||id FROM copy_preparations WHERE expires_at<?1 UNION SELECT 'export:'||id FROM export_jobs WHERE status IN ('failed','interrupted') AND retain_until<?1)",[now]))?;
        db(tx.execute(
            "UPDATE copy_preparations SET payload_hash=NULL WHERE expires_at<?1",
            [now],
        ))?;
        db(tx.execute("UPDATE export_jobs SET input_retained=0 WHERE status IN ('failed','interrupted') AND retain_until<?1",[now]))?;
        db(tx.commit())?;
        self.cleanup_export_staging(&c)?;
        Ok(())
    }
}
#[cfg(test)]
mod worker_tests {
    use super::*;
    use scenesparrow_application::manuscript::ManuscriptRepository;
    use std::sync::{Arc, Barrier};
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn shim(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let entry = dir.join(std::format!("{}.mjs", id()));
        let started = dir.join(id());
        let gate = dir.join(id());
        let code = std::format!(
            "import {{existsSync,writeFileSync,readFileSync,openSync,writeSync,fsyncSync,closeSync}} from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;const r=JSON.parse(raw);writeFileSync({},'started');while(!existsSync({}))await new Promise(r=>setTimeout(r,5));const s=JSON.parse(readFileSync(r.input,'utf8'));const bytes=Buffer.from(s.blocks.map(b=>b.runs.map(r=>r.text).join('')).join('\\n\\n')+'\\n');const f=openSync(r.output,'wx');writeSync(f,bytes);fsyncSync(f);closeSync(f);process.stdout.write(JSON.stringify({{version:1,attempt:r.attempt,size:bytes.length}}));",
            serde_json::to_string(&started).unwrap(),
            serde_json::to_string(&gate).unwrap()
        );
        std::fs::write(&entry, code).unwrap();
        (entry, started, gate)
    }
    fn wait(path: &Path) {
        let start = Instant::now();
        while !path.exists() {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "worker barrier unavailable"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn running_capture_edit_gc_and_cancel_finish_races_keep_one_honest_snapshot() {
        let (dir, repo) = super::tests::setup();
        let repo = Arc::new(repo);
        let captured = super::tests::start(&repo, "txt");
        let (entry, started, gate) = shim(dir.path());
        let worker = {
            let repo = repo.clone();
            let id = captured.id.clone();
            std::thread::spawn(move || {
                repo.run_export_at(&id, Some(&entry), Duration::from_secs(5), 512 * 1024 * 1024)
            })
        };
        wait(&started);
        assert_eq!(
            repo.export_job(&captured.id).unwrap().status,
            ExportJobStatus::Running
        );
        super::tests::edit(&repo, "Current body remains editable");
        repo.collect_objects(Duration::ZERO).unwrap();
        assert!(repo.read_object(&captured.snapshot_hash).is_ok());
        std::fs::write(gate, b"go").unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(
            String::from_utf8(repo.export_bytes(&captured.id).unwrap().1).unwrap(),
            "中文 👩‍💻 é 🔒 literal comment\n"
        );
        let history = repo.read_history().unwrap();
        for _ in 0..4 {
            let j = super::tests::start(&repo, "txt");
            let (entry, started, gate) = shim(dir.path());
            let worker = {
                let repo = repo.clone();
                let id = j.id.clone();
                std::thread::spawn(move || {
                    repo.run_export_at(&id, Some(&entry), Duration::from_secs(5), 512 * 1024 * 1024)
                })
            };
            wait(&started);
            let barrier = Arc::new(Barrier::new(3));
            let cancel = {
                let repo = repo.clone();
                let barrier = barrier.clone();
                let id = j.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    repo.cancel_export(
                        &id,
                        &ExportControl {
                            request_id: super::worker_tests::id(),
                            attempt: 1,
                        },
                    )
                })
            };
            let finish = {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    std::fs::write(gate, b"go").unwrap();
                })
            };
            barrier.wait();
            finish.join().unwrap();
            cancel.join().unwrap().unwrap();
            worker.join().unwrap().unwrap();
            let final_job = repo.export_job(&j.id).unwrap();
            assert!(matches!(
                final_job.status,
                ExportJobStatus::Ready | ExportJobStatus::Cancelled
            ));
            if final_job.status == ExportJobStatus::Ready {
                assert_eq!(
                    repo.export_bytes(&j.id).unwrap().1,
                    b"Current body remains editable\n"
                );
            } else {
                let staging = repo
                    .directory
                    .join("staging")
                    .join(std::format!("export-{}-1", j.id));
                std::fs::write(&staging, b"late\n").unwrap();
                repo.finish_export(&j.id, 1, Ok(b"late\n".to_vec()))
                    .unwrap();
                assert_eq!(
                    repo.export_job(&j.id).unwrap().status,
                    ExportJobStatus::Cancelled
                );
                assert!(!staging.exists());
            }
        }
        assert_eq!(repo.read_history().unwrap(), history);
        assert_eq!(
            repo.read_manuscript().unwrap().blocks[0].runs[0].text,
            "Current body remains editable"
        );
    }
    #[test]
    fn promotion_rename_and_directory_flush_failures_settle_and_unblock_queue() {
        let (dir, r) = super::tests::setup();
        let rename = super::tests::start(&r, "txt");
        let path = dir.path().join("exports").join(&rename.id);
        std::fs::create_dir(&path).unwrap();
        r.run_export(&rename.id).unwrap();
        assert!(
            !dir.path()
                .join("staging")
                .join(std::format!("export-{}-1", rename.id))
                .exists()
        );
        assert_eq!(
            r.export_job(&rename.id).unwrap().status,
            ExportJobStatus::Interrupted
        );
        let next = super::tests::start(&r, "txt");
        r.run_export(&next.id).unwrap();
        assert_eq!(
            r.export_job(&next.id).unwrap().status,
            ExportJobStatus::Ready
        );
        std::fs::remove_dir(path).unwrap();
        let flush = super::tests::start(&r, "txt");
        r.fail_export_directory_sync
            .store(true, std::sync::atomic::Ordering::Release);
        r.run_export(&flush.id).unwrap();
        assert_eq!(
            r.export_job(&flush.id).unwrap().status,
            ExportJobStatus::Interrupted
        );
        assert!(dir.path().join("exports").join(&flush.id).is_file());
        assert!(r.next_export().unwrap().is_none());
        drop(r);
        let reopened = SqliteProjectRepository::open(dir.path()).unwrap();
        assert_eq!(
            reopened.export_job(&flush.id).unwrap().status,
            ExportJobStatus::Ready
        );
        assert_eq!(
            reopened.export_job(&rename.id).unwrap().status,
            ExportJobStatus::Interrupted
        );
    }
    #[test]
    fn worker_startup_deadline_and_sampled_linux_memory_limit_reap_before_return() {
        let (dir, r) = super::tests::setup();
        let entry = dir.path().join("idle.mjs");
        std::fs::write(&entry, "process.stdin.pause();setInterval(()=>{},1000);").unwrap();
        let j = super::tests::start(&r, "txt");
        let start = Instant::now();
        r.run_export_at(
            &j.id,
            Some(&entry),
            Duration::from_millis(100),
            512 * 1024 * 1024,
        )
        .unwrap();
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_eq!(
            r.export_job(&j.id).unwrap().status,
            ExportJobStatus::Interrupted
        );
        assert_eq!(r.workers.load(std::sync::atomic::Ordering::Acquire), 0);
        #[cfg(target_os = "linux")]
        {
            let j = super::tests::start(&r, "txt");
            r.run_export_at(&j.id, Some(&entry), Duration::from_secs(5), 1024 * 1024)
                .unwrap();
            assert_eq!(
                r.export_job(&j.id).unwrap().error.as_deref(),
                Some("EXPORT_TOO_LARGE")
            );
            assert_eq!(r.workers.load(std::sync::atomic::Ordering::Acquire), 0);
        }
    }
    #[test]
    fn terminal_input_expiry_and_cross_operation_request_identity_do_not_recapture_silently() {
        let (_dir, r) = super::tests::setup();
        let j = super::tests::start(&r, "txt");
        {
            let c = r.connection.lock().unwrap();
            c.execute("UPDATE export_jobs SET status='failed',error='EXPORT_FAILED',retain_until=0 WHERE id=?1",[&j.id]).unwrap();
        }
        let obsolete = r
            .directory
            .join("staging")
            .join(std::format!("export-{}-1", j.id));
        std::fs::write(&obsolete, b"abandoned output").unwrap();
        let unrelated = r.directory.join("staging").join("user-owned");
        std::fs::write(&unrelated, b"preserve").unwrap();
        r.prune_export_inputs().unwrap();
        assert!(!obsolete.exists());
        assert_eq!(std::fs::read(unrelated).unwrap(), b"preserve");
        r.collect_objects(Duration::ZERO).unwrap();
        assert!(!r.export_job(&j.id).unwrap().input_retained);
        assert!(!r.directory.join("objects").join(&j.snapshot_hash).exists());
        let retained = ExportRetry {
            request_id: id(),
            attempt: 1,
            mode: ExportRetryMode::Retained,
            expected_revision: 2,
            expected_body_hash: None,
        };
        assert_eq!(
            r.retry_export(&j.id, &retained).unwrap_err().0,
            "INVALID_RETRY"
        );
        let recapture = ExportRetry {
            request_id: id(),
            mode: ExportRetryMode::Recapture,
            ..retained
        };
        let next = r.retry_export(&j.id, &recapture).unwrap();
        assert_eq!(r.retry_export(&j.id, &recapture).unwrap(), next);
        let altered = ExportRetry {
            attempt: 2,
            ..recapture
        };
        assert_eq!(
            r.retry_export(&j.id, &altered).unwrap_err().0,
            "INVALID_REQUEST"
        );
        let control = ExportControl {
            request_id: id(),
            attempt: 1,
        };
        r.cancel_export(&next.id, &control).unwrap();
        let collision = ExportRequest {
            request_id: control.request_id,
            expected_revision: 2,
            expected_body_hash: None,
            format: ExportRequestFormat::Txt,
        };
        assert_eq!(r.start_export(&collision).unwrap_err().0, "INVALID_REQUEST");
        let state = r.read_manuscript().unwrap();
        let copy = CopyRequest {
            request_id: id(),
            expected_revision: 2,
            expected_body_hash: hash(scenesparrow_domain::exports::body_token(&state).as_bytes()),
        };
        r.prepare_copy(&copy).unwrap();
        {
            let c = r.connection.lock().unwrap();
            c.execute(
                "UPDATE copy_preparations SET expires_at=0 WHERE id=?1",
                [&copy.request_id],
            )
            .unwrap();
        }
        r.prune_export_inputs().unwrap();
        assert_eq!(r.prepare_copy(&copy).unwrap_err().0, "CAPABILITY_EXPIRED");
    }
}
#[cfg(test)]
mod backup_fault_tests {
    use super::*;
    use scenesparrow_application::manuscript::ManuscriptRepository;
    use std::sync::{Arc, Barrier};
    #[test]
    fn rooted_backup_ignores_human_exports_and_corrupt_orphans_and_races_gc_consistently() {
        let (dir, r) = super::tests::setup();
        let j = super::tests::start(&r, "md");
        r.run_export(&j.id).unwrap();
        let human = dir.path().join("exports").join("正文.docx");
        std::fs::write(&human, b"user-owned delivery").unwrap();
        let orphan = "f".repeat(64);
        std::fs::write(
            dir.path().join("objects").join(&orphan),
            b"unreferenced corrupt orphan",
        )
        .unwrap();
        let body = r.read_manuscript().unwrap();
        let history = r.read_history().unwrap();
        let backup = r.verified_backup().unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(backup.join("manifest.json")).unwrap()).unwrap();
        assert!(manifest["files"].get("exports/正文.docx").is_none());
        assert!(
            manifest["files"]
                .get(std::format!("objects/{orphan}"))
                .is_none()
        );
        assert_eq!(std::fs::read(&human).unwrap(), b"user-owned delivery");
        assert_eq!(
            std::fs::read(dir.path().join("objects").join(&orphan)).unwrap(),
            b"unreferenced corrupt orphan"
        );
        let r = Arc::new(r);
        let barrier = Arc::new(Barrier::new(3));
        let copying = {
            let r = r.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                r.verified_backup()
            })
        };
        let gc = {
            let r = r.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                r.collect_objects(Duration::ZERO)
            })
        };
        barrier.wait();
        let raced = copying.join().unwrap().unwrap();
        gc.join().unwrap().unwrap();
        let restored =
            SqliteProjectRepository::restore_verified_copy(&raced, &dir.path().join("restored-gc"))
                .unwrap();
        assert_eq!(restored.read_manuscript().unwrap(), body);
        let restored_history = restored.read_history().unwrap();
        assert_eq!(restored_history.cursor, history.cursor);
        assert_eq!(restored_history.undo_count, history.undo_count);
        assert_eq!(restored_history.redo_count, history.redo_count);
        assert_eq!(restored_history.working_revision, history.working_revision);
        assert_eq!(
            restored.export_bytes(&j.id).unwrap().1,
            r.export_bytes(&j.id).unwrap().1
        );
    }
    #[test]
    fn omitted_manifest_root_and_intermediate_symlink_are_rejected_before_creating_a_copy() {
        let (dir, r) = super::tests::setup();
        let backup = r.verified_backup().unwrap();
        let manifest_path = backup.join("manifest.json");
        let original = std::fs::read(&manifest_path).unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(&original).unwrap();
        let key = manifest["files"]
            .as_object()
            .unwrap()
            .keys()
            .find(|k| k.starts_with("objects/"))
            .unwrap()
            .clone();
        manifest["files"].as_object_mut().unwrap().remove(&key);
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let target = dir.path().join("omitted");
        assert!(SqliteProjectRepository::restore_verified_copy(&backup, &target).is_err());
        assert!(!target.exists());
        std::fs::write(&manifest_path, &original).unwrap();
        #[cfg(unix)]
        {
            let outside = dir.path().join("outside-objects");
            std::fs::rename(backup.join("objects"), &outside).unwrap();
            let canary =
                std::fs::read(outside.join(key.strip_prefix("objects/").unwrap())).unwrap();
            std::os::unix::fs::symlink(&outside, backup.join("objects")).unwrap();
            let target = dir.path().join("symlink");
            assert!(SqliteProjectRepository::restore_verified_copy(&backup, &target).is_err());
            assert!(!target.exists());
            assert_eq!(
                std::fs::read(outside.join(key.strip_prefix("objects/").unwrap())).unwrap(),
                canary
            );
        }
    }
}
