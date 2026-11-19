use super::*;
use crate::{SqliteProjectRepository, storage::hash};
use atomic_write_file::AtomicWriteFile;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use scenesparrow_application::ai::*;
use std::{collections::BTreeMap, io::Write};

type RunRow = (
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
);
pub type AiInputPayload = (Vec<u8>, BTreeMap<String, Vec<u8>>);

fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T> {
    safe(serde_json::from_str(json))
}
fn encode<T: serde::Serialize>(value: &T) -> Result<String> {
    safe(serde_json::to_string(value))
}
fn id(id: &str) -> Result<()> {
    ensure(valid_id(id), "INVALID_REQUEST")
}
pub struct AiUnitOfWork<'a> {
    pub(crate) tx: &'a Transaction<'a>,
    pub(crate) prepared: Option<&'a AiInput>,
}
impl SqliteProjectRepository {
    pub fn register_ai_consumer(
        &self,
        owner: std::sync::Arc<dyn ConsumerCoordinator>,
    ) -> Result<()> {
        let name = owner.name().to_owned();
        ensure(!name.is_empty() && name.len() <= 64, "INVALID_REQUEST")?;
        safe(self.ai_consumers.lock())?.insert(name.clone(), owner.clone());
        let mut c = safe(self.connection.lock())?;
        let ids: Vec<String> = {
            let mut stmt =
                safe(c.prepare("SELECT run_id FROM ai_consumer_cleanup WHERE owner=?1"))?;
            safe(stmt.query_map([&name], |r| r.get(0)))?
                .map(safe)
                .collect::<Result<_>>()?
        };
        let tx = safe(c.transaction())?;
        for id in ids {
            let run = Self::ai_run(&tx, &id)?;
            owner.terminal_failure(
                &mut AiUnitOfWork {
                    tx: &tx,
                    prepared: None,
                },
                &run,
            )?;
            safe(tx.execute("DELETE FROM ai_consumer_cleanup WHERE run_id=?1", [id]))?;
        }
        safe(tx.commit())
    }
    pub(crate) fn ai_run(c: &Connection, run_id: &str) -> Result<AiRun> {
        let (request,input,config,status,attempt,error,result,retry,consumer,binding): RunRow = safe(c.query_row("SELECT request_id,input_hash,config_json,status,attempt,error,result_json,retry_of_run_id,consumer,binding_id FROM ai_runs WHERE run_id=?1",[run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional())?.ok_or(AiError("RUN_NOT_FOUND"))?;
        let completion: Option<String> = safe(c.query_row(
            "SELECT completion_json FROM ai_runs WHERE run_id=?1",
            [run_id],
            |r| r.get(0),
        ))?;
        let usage = completion
            .as_deref()
            .map(decode::<AiCompletion>)
            .transpose()?
            .and_then(|receipt| receipt.usage);
        Ok(AiRun {
            usage,
            run_id: run_id.into(),
            request_id: request,
            input_hash: input,
            configuration: super::legacy::read_configuration(&config)?,
            status: decode(&format!("\"{status}\""))?,
            attempt,
            error,
            result: result.as_deref().map(decode).transpose()?,
            retry_of_run_id: retry,
            consumer,
            binding_id: binding,
        })
    }
    fn ai_replay(c: &Connection, start: &AiStart) -> Result<Option<AiRun>> {
        let row: Option<(String, String)> = safe(
            c.query_row(
                "SELECT request_digest,run_id FROM ai_runs WHERE request_id=?1",
                [&start.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional(),
        )?;
        if let Some((digest, run)) = row {
            ensure(
                digest == hash(encode(start)?.as_bytes()),
                "REQUEST_ID_REUSED",
            )?;
            return Self::ai_run(c, &run).map(Some);
        }
        Ok(None)
    }
    fn ai_event(c: &Connection, run: &AiRun) -> Result<()> {
        safe(c.execute(
            "INSERT INTO ai_events(run_id,status,error) VALUES(?1,?2,?3)",
            params![run.run_id, word(&run.status), run.error],
        ))?;
        safe(c.execute("DELETE FROM ai_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM ai_events)",[]))?;
        safe(c.execute("INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,'aiRun.changed',?2)",params![run.request_id,serde_json::json!({"affectedIds":[run.run_id]}).to_string()]))?;
        safe(c.execute("DELETE FROM project_events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-1000 FROM project_events)",[]))?;
        Ok(())
    }
    /// Promotion and registration share the project writer, so GC cannot observe
    /// promoted pending objects without a live preparation root.
    pub fn prepare_ai_input(
        &self,
        preparation_id: &str,
        input: &AiInput,
        artifacts: &BTreeMap<String, Vec<u8>>,
    ) -> Result<String> {
        id(preparation_id)?;
        ensure(input.input_artifacts.len() <= 9, "INPUT_TOO_LARGE")?;
        let mut c = safe(self.connection.lock())?;
        let mut hashes = vec![];
        for a in &input.input_artifacts {
            let bytes = artifacts.get(&a.id).ok_or(AiError("ARTIFACT_MISMATCH"))?;
            ensure(
                bytes.len() <= 4194304 && a.size == bytes.len() as i64 && hash(bytes) == a.hash,
                "ARTIFACT_MISMATCH",
            )?;
            hashes.push(
                self.object(bytes)
                    .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?,
            );
        }
        let bytes = safe(serde_json::to_vec(input))?;
        ensure(bytes.len() <= 8 * 1024 * 1024, "INPUT_TOO_LARGE")?;
        let input_hash = self
            .object(&bytes)
            .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?;
        hashes.push(input_hash.clone());
        let tx = safe(c.transaction())?;
        safe(tx.execute(
            "INSERT OR IGNORE INTO ai_preparations VALUES(?1)",
            [preparation_id],
        ))?;
        for h in hashes {
            safe(tx.execute(
                "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
                params![preparation_id, h],
            ))?;
        }
        safe(tx.commit())?;
        Ok(input_hash)
    }
    pub fn release_ai_preparation(&self, preparation_id: &str) -> Result<()> {
        id(preparation_id)?;
        let mut c = safe(self.connection.lock())?;
        let tx = safe(c.transaction())?;
        safe(tx.execute("DELETE FROM external_object_pins WHERE owner_id=?1 AND EXISTS(SELECT 1 FROM ai_preparations WHERE owner_id=?1)",[preparation_id]))?;
        safe(tx.execute(
            "DELETE FROM ai_preparations WHERE owner_id=?1",
            [preparation_id],
        ))?;
        safe(tx.commit())
    }
    pub fn accept_ai(
        &self,
        settings: &dyn AiSettingsPort,
        start: &AiStart,
        participant: &mut dyn FnMut(&mut dyn ProjectUnitOfWork, &AiRun) -> Result<()>,
    ) -> Result<AiRun> {
        self.accept_ai_module(settings, start, &mut |_, uow, run| participant(uow, run))
    }
    pub(crate) fn accept_ai_module(
        &self,
        settings: &dyn AiSettingsPort,
        start: &AiStart,
        participant: &mut dyn FnMut(&Connection, &mut dyn ProjectUnitOfWork, &AiRun) -> Result<()>,
    ) -> Result<AiRun> {
        id(&start.request_id)?;
        id(&start.run_id)?;
        id(&start.binding_id)?;
        // Lifetime idempotency precedes readiness, configuration and consumer guards.
        {
            let c = safe(self.connection.lock())?;
            if let Some(run) = Self::ai_replay(&c, start)? {
                return Ok(run);
            }
        }
        ensure(
            safe(self.ai_consumers.lock())?.contains_key(&start.consumer),
            "CONSUMER_UNAVAILABLE",
        )?;
        let mut result = None;
        settings.with_resolved_configuration(&start.fingerprint, &mut |guard| {
            let mut c = safe(self.connection.lock())?;
            if let Some(run) = Self::ai_replay(&c, start)? {
                result = Some(run);
                return Ok(());
            }
            let bytes = self
                .read_object(&start.input_hash)
                .map_err(|_| AiError("ARTIFACT_MISMATCH"))?;
            let input: AiInput = safe(serde_json::from_slice(&bytes))?;
            validate_input(&input, guard.configuration())?;
            for a in &input.input_artifacts {
                let data = self
                    .read_object(&a.hash)
                    .map_err(|_| AiError("ARTIFACT_MISMATCH"))?;
                ensure(data.len() as i64 == a.size, "ARTIFACT_MISMATCH")?;
            }
            let tx = safe(c.transaction())?;
            let mut uow = AiUnitOfWork {
                tx: &tx,
                prepared: Some(&input),
            };
            let run = uow.enqueue_in_unit_of_work(guard, start)?;
            participant(&tx, &mut uow, &run)?;
            // A rejected queue/consumer request has no dispatch intent. Advance
            // the external crash fence only once all ordinary checks succeeded.
            let watermark = self.ai_prepare_watermark(&tx)?;
            self.ai_commit_watermark(&tx, watermark)?;
            safe(tx.commit())?;
            result = Some(run);
            Ok(())
        })?;
        result.ok_or(AiError("STORAGE_UNAVAILABLE"))
    }
    pub fn claim_ai(&self) -> Result<Option<(AiRun, String)>> {
        let mut c = safe(self.connection.lock())?;
        if self.is_quiescing() {
            return Ok(None);
        }
        let active: i64 = safe(c.query_row(
            "SELECT COUNT(*) FROM ai_runs WHERE status IN ('running','cancelling')",
            [],
            |r| r.get(0),
        ))?;
        if active > 0 {
            return Ok(None);
        }
        let next:Option<String> = safe(c.query_row("SELECT run_id FROM ai_runs WHERE status='queued' AND attempt=0 AND NOT EXISTS(SELECT 1 FROM ai_dispatches d WHERE d.run_id=ai_runs.run_id) ORDER BY rowid LIMIT 1",[],|r|r.get(0)).optional())?;
        let Some(run_id) = next else {
            return Ok(None);
        };
        let fence = uuid::Uuid::new_v4().to_string();
        let watermark = self.ai_prepare_watermark(&c)?;
        let tx = safe(c.transaction())?;
        safe(tx.execute("UPDATE ai_runs SET status='running',attempt=1,fence=?2 WHERE run_id=?1 AND status='queued'",params![run_id,fence]))?;
        safe(tx.execute(
            "INSERT INTO ai_attempts VALUES(?1,1,?2,'running')",
            params![run_id, fence],
        ))?;
        let run = Self::ai_run(&tx, &run_id)?;
        Self::ai_event(&tx, &run)?;
        self.ai_commit_watermark(&tx, watermark)?;
        safe(tx.commit())?;
        Ok(Some((run, fence)))
    }
    pub(crate) fn ai_has_retired_configuration(&self, run_id: &str) -> Result<bool> {
        let c = safe(self.connection.lock())?;
        let json: String = safe(c.query_row(
            "SELECT config_json FROM ai_runs WHERE run_id=?1",
            [run_id],
            |r| r.get(0),
        ))?;
        let value = safe(serde_json::from_str(&json))?;
        Ok(super::legacy::has_retired_configuration(&value))
    }
    pub fn dispatch_ai(&self, run_id: &str, attempt: i64, fence: &str, input: &str) -> Result<()> {
        ensure(
            !self.ai_has_retired_configuration(run_id)?,
            "CONFIGURATION_STALE",
        )?;
        let mut c = safe(self.connection.lock())?;
        let allowed:bool = safe(c.query_row("SELECT EXISTS(SELECT 1 FROM ai_runs WHERE run_id=?1 AND attempt=?2 AND fence=?3 AND input_hash=?4 AND status='running')",params![run_id,attempt,fence,input],|r|r.get(0)))?;
        ensure(allowed, "STALE_ATTEMPT")?;
        let exists: bool = safe(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_dispatches WHERE run_id=?1)",
            [run_id],
            |r| r.get(0),
        ))?;
        ensure(!exists, "DISPATCH_ALREADY_MARKED")?;
        let watermark = self.ai_prepare_watermark(&c)?;
        let tx = safe(c.transaction())?;
        safe(tx.execute(
            "INSERT INTO ai_dispatches(run_id,attempt,fence,input_hash) VALUES(?1,?2,?3,?4)",
            params![run_id, attempt, fence, input],
        ))?;
        self.ai_commit_watermark(&tx, watermark)?;
        safe(tx.commit())
    }
    pub fn complete_ai(&self, receipt: &AiCompletion, bytes: &[u8]) -> Result<AiRun> {
        ensure(
            bytes.len() <= 8388608 && hash(bytes) == receipt.output_hash,
            "ARTIFACT_MISMATCH",
        )?;
        let text = std::str::from_utf8(bytes).map_err(|_| AiError("INVALID_OUTPUT"))?;
        ensure(
            !text.trim().is_empty() && !text.contains('\0'),
            "INVALID_OUTPUT",
        )?;
        let mut c = safe(self.connection.lock())?;
        let run = Self::ai_run(&c, &receipt.run_id)?;
        let digest = hash(encode(receipt)?.as_bytes());
        if terminal(&run.status) {
            let previous: Option<String> = safe(c.query_row(
                "SELECT receipt_digest FROM ai_runs WHERE run_id=?1",
                [&receipt.run_id],
                |r| r.get(0),
            ))?;
            ensure(
                previous.as_deref() == Some(&digest) && run.status == AiRunStatus::Succeeded,
                "STALE_RECEIPT",
            )?;
            return Ok(run);
        }
        let valid:bool = safe(c.query_row("SELECT EXISTS(SELECT 1 FROM ai_runs r JOIN ai_dispatches d ON d.run_id=r.run_id WHERE r.run_id=?1 AND r.status='running' AND r.attempt=?2 AND r.fence=?3 AND r.input_hash=?4 AND d.attempt=?2 AND d.fence=?3 AND d.input_hash=?4)",params![receipt.run_id,receipt.attempt,receipt.fence,receipt.input_hash],|r|r.get(0)))?;
        ensure(valid, "STALE_RECEIPT")?;
        let input: AiInput = safe(serde_json::from_slice(
            &self
                .read_object(&run.input_hash)
                .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?,
        ))?;
        ensure(
            bytes.len() as i64 <= input.output_spec.max_bytes
                && bytes.len() as i64 <= run.configuration.policy.max_output_bytes,
            "OUTPUT_TRUNCATED",
        )?;
        if word(&input.output_spec.mime) == "application/json" {
            let _: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|_| AiError("INVALID_OUTPUT"))?;
        }
        let output_hash = self
            .object(bytes)
            .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?;
        let artifact = AiArtifact {
            id: uuid::Uuid::new_v4().to_string(),
            hash: output_hash,
            mime: decode(&encode(&input.output_spec.mime)?)?,
            size: bytes.len() as i64,
        };
        let watermark = self.ai_prepare_watermark(&c)?;
        let tx = safe(c.transaction())?;
        safe(tx.execute(
            "INSERT INTO ai_artifacts VALUES(?1,?2,?3,?4,?5)",
            params![
                run.run_id,
                artifact.id,
                artifact.hash,
                word(&artifact.mime),
                artifact.size
            ],
        ))?;
        safe(tx.execute("UPDATE ai_runs SET status='succeeded',result_json=?2,receipt_digest=?3,completion_json=?4,fence=NULL WHERE run_id=?1",params![run.run_id,encode(&artifact)?,digest,encode(receipt)?]))?;
        safe(tx.execute(
            "UPDATE ai_attempts SET status='succeeded' WHERE run_id=?1",
            [&run.run_id],
        ))?;
        let run = Self::ai_run(&tx, &run.run_id)?;
        Self::ai_event(&tx, &run)?;
        self.ai_commit_watermark(&tx, watermark)?;
        safe(tx.commit())?;
        Ok(run)
    }
    pub fn fail_ai(&self, run_id: &str, fence: &str, error: &'static str) -> Result<AiRun> {
        let mut c = safe(self.connection.lock())?;
        let run = Self::ai_run(&c, run_id)?;
        if terminal(&run.status) {
            return Ok(run);
        }
        let valid: bool = safe(c.query_row(
            "SELECT fence=?2 FROM ai_runs WHERE run_id=?1",
            params![run_id, fence],
            |r| r.get(0),
        ))?;
        ensure(valid, "STALE_ATTEMPT")?;
        let watermark = self.ai_prepare_watermark(&c)?;
        let tx = safe(c.transaction())?;
        safe(tx.execute(
            "UPDATE ai_runs SET status=?3,error=?2,fence=NULL WHERE run_id=?1",
            params![
                run_id,
                error,
                if error == "WORKER_INTERRUPTED" {
                    "interrupted"
                } else {
                    "failed"
                }
            ],
        ))?;
        safe(tx.execute(
            "UPDATE ai_attempts SET status=?2 WHERE run_id=?1",
            params![
                run_id,
                if error == "WORKER_INTERRUPTED" {
                    "interrupted"
                } else {
                    "failed"
                }
            ],
        ))?;
        let run = Self::ai_run(&tx, run_id)?;
        if let Some(owner) = safe(self.ai_consumers.lock())?.get(&run.consumer).cloned() {
            owner.terminal_failure(
                &mut AiUnitOfWork {
                    tx: &tx,
                    prepared: None,
                },
                &run,
            )?;
        } else {
            safe(tx.execute(
                "INSERT OR IGNORE INTO ai_consumer_cleanup VALUES(?1,?2)",
                params![run_id, run.consumer],
            ))?;
        }
        Self::ai_event(&tx, &run)?;
        self.ai_commit_watermark(&tx, watermark)?;
        safe(tx.commit())?;
        Ok(run)
    }
    pub fn cancel_ai(
        &self,
        run_id: &str,
        coordinators: &[&dyn ConsumerCoordinator],
    ) -> Result<AiRun> {
        let mut c = safe(self.connection.lock())?;
        let watermark = self.ai_prepare_watermark(&c)?;
        let tx = safe(c.transaction())?;
        let run = Self::ai_run(&tx, run_id)?;
        let registered = safe(self.ai_consumers.lock())?.get(&run.consumer).cloned();
        let owner = coordinators
            .iter()
            .copied()
            .find(|owner| owner.name() == run.consumer)
            .or(registered.as_deref())
            .ok_or(AiError("CONSUMER_UNAVAILABLE"))?;
        let mut uow = AiUnitOfWork {
            tx: &tx,
            prepared: None,
        };
        ensure(owner.cancel(&mut uow, &run)?, "ALREADY_APPLIED")?;
        let run = uow.cancel_in_unit_of_work(run_id)?;
        self.ai_commit_watermark(&tx, watermark)?;
        safe(tx.commit())?;
        Ok(run)
    }
    /// Consumers call this after their own applicability/version/semantic checks.
    /// The owner callback stages business state and the application fence together.
    pub fn apply_ai_consumer(
        &self,
        owner: &str,
        binding_id: &str,
        apply: &mut dyn FnMut(&mut dyn ProjectUnitOfWork, &AiRun) -> Result<()>,
    ) -> Result<()> {
        let mut c = safe(self.connection.lock())?;
        let tx = safe(c.transaction())?;
        let (run_id,state):(String,String)=safe(tx.query_row("SELECT run_id,applicability FROM application_execution_bindings WHERE owner=?1 AND binding_id=?2",params![owner,binding_id],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if state == "applied" {
            return Ok(());
        }
        ensure(state == "pending", "CONSUMER_CANCELLED")?;
        let run = Self::ai_run(&tx, &run_id)?;
        ensure(run.status == AiRunStatus::Succeeded, "RESULT_UNAVAILABLE")?;
        apply(
            &mut AiUnitOfWork {
                tx: &tx,
                prepared: None,
            },
            &run,
        )?;
        safe(tx.execute("UPDATE application_execution_bindings SET applicability='applied' WHERE owner=?1 AND binding_id=?2",params![owner,binding_id]))?;
        safe(tx.commit())
    }
    pub fn ai_input_bytes(&self, run: &AiRun) -> Result<AiInputPayload> {
        let _c = safe(self.connection.lock())?;
        let bytes = self
            .read_object(&run.input_hash)
            .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?;
        let input: AiInput = safe(serde_json::from_slice(&bytes))?;
        let mut artifacts = BTreeMap::new();
        for artifact in input.input_artifacts {
            artifacts.insert(
                artifact.id,
                self.read_object(&artifact.hash)
                    .map_err(|_| AiError("ARTIFACT_MISMATCH"))?,
            );
        }
        Ok((bytes, artifacts))
    }
}
impl ProjectUnitOfWork for AiUnitOfWork<'_> {
    fn enqueue_in_unit_of_work(
        &mut self,
        guard: &ConfigurationGuard,
        start: &AiStart,
    ) -> Result<AiRun> {
        if let Some(run) = SqliteProjectRepository::ai_replay(self.tx, start)? {
            return Ok(run);
        }
        ensure(
            start.consumer.len() <= 64 && !start.consumer.is_empty(),
            "INVALID_REQUEST",
        )?;
        let queued: i64 = safe(self.tx.query_row(
            "SELECT COUNT(*) FROM ai_runs WHERE status='queued'",
            [],
            |r| r.get(0),
        ))?;
        ensure(queued < 8, "QUEUE_FULL")?;
        let input = self.prepared.ok_or(AiError("PREPARATION_UNAVAILABLE"))?;
        ensure(
            guard.configuration().fingerprint == start.fingerprint,
            "CONFIGURATION_STALE",
        )?;
        let pinned:bool=safe(self.tx.query_row("SELECT EXISTS(SELECT 1 FROM external_object_pins WHERE owner_id=?1 AND object_hash=?2)",params![start.request_id,start.input_hash],|r|r.get(0)))?;
        ensure(pinned, "PREPARATION_UNAVAILABLE")?;
        for a in &input.input_artifacts {
            let pinned:bool=safe(self.tx.query_row("SELECT EXISTS(SELECT 1 FROM external_object_pins WHERE owner_id=?1 AND object_hash=?2)",params![start.request_id,a.hash],|r|r.get(0)))?;
            ensure(pinned, "PREPARATION_UNAVAILABLE")?;
        }
        if let Some(old) = &start.retry_of_run_id {
            let run = SqliteProjectRepository::ai_run(self.tx, old)?;
            ensure(
                terminal(&run.status) && old != &start.run_id,
                "INVALID_RETRY",
            )?;
        }
        safe(self.tx.execute(
            "INSERT OR IGNORE INTO ai_input_snapshots VALUES(?1,?1,1)",
            [&start.input_hash],
        ))?;
        safe(self.tx.execute("INSERT INTO ai_runs(run_id,request_id,request_digest,input_hash,config_json,status,retry_of_run_id,consumer,binding_id) VALUES(?1,?2,?3,?4,?5,'queued',?6,?7,?8)",params![start.run_id,start.request_id,hash(encode(start)?.as_bytes()),start.input_hash,encode(guard.configuration())?,start.retry_of_run_id,start.consumer,start.binding_id]))?;
        for a in &input.input_artifacts {
            safe(self.tx.execute(
                "INSERT INTO ai_artifacts VALUES(?1,?2,?3,?4,?5)",
                params![start.run_id, a.id, a.hash, word(&a.mime), a.size],
            ))?;
        }
        safe(self.tx.execute("INSERT OR IGNORE INTO external_object_pins SELECT ?2,object_hash FROM external_object_pins WHERE owner_id=?1",params![start.request_id,start.run_id]))?;
        safe(self.tx.execute(
            "DELETE FROM external_object_pins WHERE owner_id=?1",
            [&start.request_id],
        ))?;
        safe(self.tx.execute(
            "DELETE FROM ai_preparations WHERE owner_id=?1",
            [&start.request_id],
        ))?;
        let run = SqliteProjectRepository::ai_run(self.tx, &start.run_id)?;
        SqliteProjectRepository::ai_event(self.tx, &run)?;
        Ok(run)
    }
    fn cancel_in_unit_of_work(&mut self, run_id: &str) -> Result<AiRun> {
        let run = SqliteProjectRepository::ai_run(self.tx, run_id)?;
        if terminal(&run.status) {
            return Ok(run);
        }
        safe(self.tx.execute(
            "UPDATE ai_runs SET status='cancelled',error='CANCELLED',fence=NULL WHERE run_id=?1",
            [run_id],
        ))?;
        safe(self.tx.execute(
            "UPDATE ai_attempts SET status='cancelled' WHERE run_id=?1",
            [run_id],
        ))?;
        let run = SqliteProjectRepository::ai_run(self.tx, run_id)?;
        SqliteProjectRepository::ai_event(self.tx, &run)?;
        Ok(run)
    }
    fn stage_consumer_record(
        &mut self,
        owner: &str,
        binding: &str,
        run: &str,
        payload: &str,
    ) -> Result<()> {
        ensure(payload.len() <= 1048576, "INPUT_TOO_LARGE")?;
        safe(self.tx.execute(
            "INSERT INTO application_execution_bindings VALUES(?1,?2,?3,?4,'pending')",
            params![owner, binding, run, payload],
        ))?;
        Ok(())
    }
    fn fence_consumer(&mut self, owner: &str, binding: &str) -> Result<bool> {
        let state:String=safe(self.tx.query_row("SELECT applicability FROM application_execution_bindings WHERE owner=?1 AND binding_id=?2",params![owner,binding],|r|r.get(0)))?;
        if state == "applied" {
            return Ok(false);
        }
        safe(self.tx.execute("UPDATE application_execution_bindings SET applicability='cancelled' WHERE owner=?1 AND binding_id=?2",params![owner,binding]))?;
        Ok(true)
    }
}
// This registry is application infrastructure, outside project backups. Path AND
// native file identity AND a monotonic durable watermark establish execution origin.
impl SqliteProjectRepository {
    fn origin_record(&self, c: &Connection) -> Result<(String, i64)> {
        safe(c.query_row(
            "SELECT origin_id,watermark FROM ai_execution_origin",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ))
    }
    fn origin_file(&self) -> Result<std::path::PathBuf> {
        let base = settings::app_data_directory().join("execution-origins");
        safe(std::fs::create_dir_all(&base))?;
        let canonical = safe(std::fs::canonicalize(self.directory.join("project.sqlite")))?;
        Ok(base.join(format!(
            "{}.json",
            hash(canonical.to_string_lossy().as_bytes())
        )))
    }
    fn origin_identity(&self) -> Result<String> {
        Ok(format!(
            "{:?}",
            safe(file_id::get_file_id(self.directory.join("project.sqlite")))?
        ))
    }
    fn origin_write(&self, c: &Connection) -> Result<()> {
        let (origin, watermark) = self.origin_record(c)?;
        let mut f = safe(AtomicWriteFile::open(self.origin_file()?))?;
        safe(f.write_all(serde_json::json!({"origin":origin,"watermark":watermark,"fileIdentity":self.origin_identity()?}).to_string().as_bytes()))?;
        safe(f.commit())
    }
    pub(crate) fn execution_origin_is_original(&self, c: &Connection) -> Result<bool> {
        let (origin, watermark) = self.origin_record(c)?;
        let record = std::fs::read(self.origin_file()?)
            .ok()
            .and_then(|v| serde_json::from_slice::<serde_json::Value>(&v).ok());
        Ok(record.is_some_and(|r| {
            r["origin"].as_str() == Some(&origin)
                && r["fileIdentity"].as_str() == self.origin_identity().ok().as_deref()
                && r["watermark"].as_i64() == Some(watermark)
        }))
    }
    pub(crate) fn initialize_ai_origin(&self) -> Result<()> {
        let c = safe(self.connection.lock())?;
        self.origin_write(&c)
    }
    pub(crate) fn ai_prepare_watermark(&self, c: &Connection) -> Result<i64> {
        let (origin, old) = self.origin_record(c)?;
        ensure(old < 9223372036854775806, "REVISION_EXHAUSTED")?;
        let next = old + 1;
        let mut f = safe(AtomicWriteFile::open(self.origin_file()?))?;
        safe(f.write_all(serde_json::json!({"origin":origin,"watermark":next,"fileIdentity":self.origin_identity()?}).to_string().as_bytes()))?;
        safe(f.commit())?;
        Ok(next)
    }
    pub(crate) fn ai_commit_watermark(&self, c: &Connection, next: i64) -> Result<()> {
        let changed = safe(c.execute(
            "UPDATE ai_execution_origin SET watermark=?1 WHERE watermark=?2",
            params![next, next - 1],
        ))?;
        ensure(changed == 1, "REVISION_EXHAUSTED")
    }
    pub fn prune_ai_payload(&self, run_id: &str) -> Result<()> {
        let mut c = safe(self.connection.lock())?;
        let run = Self::ai_run(&c, run_id)?;
        ensure(terminal(&run.status), "RUN_ACTIVE")?;
        let pending:bool=safe(c.query_row("SELECT EXISTS(SELECT 1 FROM application_execution_bindings WHERE run_id=?1 AND applicability='pending')",[run_id],|r|r.get(0)))?;
        ensure(!pending, "ARTIFACT_PINNED")?;
        let tx = safe(c.transaction())?;
        safe(tx.execute(
            "DELETE FROM external_object_pins WHERE owner_id=?1",
            [run_id],
        ))?;
        safe(tx.execute("DELETE FROM ai_artifacts WHERE run_id=?1", [run_id]))?;
        // Result manifest and compact immutable receipt survive; a later result
        // read reports payload unavailable. Consumer/history pins remain roots.
        safe(tx.execute("UPDATE ai_input_snapshots SET payload_retained=0 WHERE input_hash=?1 AND NOT EXISTS(SELECT 1 FROM ai_runs WHERE input_hash=?1 AND status IN ('queued','running','cancelling'))",[&run.input_hash]))?;
        safe(tx.commit())
    }
}
impl AiExecutionPort for SqliteProjectRepository {
    fn read_run(&self, run_id: &str) -> Result<AiRun> {
        id(run_id)?;
        let c = safe(self.connection.lock())?;
        Self::ai_run(&c, run_id)
    }
    fn read_result(&self, run_id: &str) -> Result<Option<Vec<u8>>> {
        let c = safe(self.connection.lock())?;
        let run = Self::ai_run(&c, run_id)?;
        run.result
            .map(|a| {
                self.read_object(&a.hash)
                    .map_err(|_| AiError("RESULT_UNAVAILABLE"))
            })
            .transpose()
    }
    fn observe_run(&self, run_id: &str, after: i64) -> Result<Vec<ProjectEvent>> {
        let c = safe(self.connection.lock())?;
        Self::ai_run(&c, run_id)?;
        let first: i64 = safe(c.query_row(
            "SELECT COALESCE(MIN(sequence),0) FROM ai_events",
            [],
            |r| r.get(0),
        ))?;
        ensure(after == 0 || after >= first - 1, "RESYNC_REQUIRED")?;
        let project = crate::read_project(&c)
            .map_err(|_| AiError("STORAGE_UNAVAILABLE"))?
            .ok_or(AiError("PROJECT_NOT_FOUND"))?;
        let mut stmt=safe(c.prepare("SELECT sequence,status FROM ai_events WHERE run_id=?1 AND sequence>?2 ORDER BY sequence LIMIT 1000"))?;
        safe(stmt.query_map(params![run_id, after], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        }))?
        .map(|row| {
            let (sequence, _) = safe(row)?;
            Ok(ProjectEvent {
                sequence,
                project_id: project.id.clone(),
                r#type: ProjectEventType::AiRunchanged,
                request_id: None,
                affected_ids: vec![run_id.into()],
                working_revision: project.working_revision,
            })
        })
        .collect()
    }
    fn prepare_manual_retry(&self, old: &str, start: &AiStart) -> Result<()> {
        let run = self.read_run(old)?;
        ensure(
            terminal(&run.status)
                && start.retry_of_run_id.as_deref() == Some(old)
                && start.run_id != old
                && start.request_id != run.request_id,
            "INVALID_RETRY",
        )
    }
    fn reconcile_execution(&self) -> Result<()> {
        let mut c = safe(self.connection.lock())?;
        let original = self.execution_origin_is_original(&c)?;
        let tx = safe(c.transaction())?;
        safe(tx.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT owner_id FROM ai_preparations)",[]))?;
        safe(tx.execute("DELETE FROM ai_preparations", []))?;
        let ids: Vec<String> = {
            let mut stmt=safe(tx.prepare(if original { "SELECT run_id FROM ai_runs WHERE status IN ('running','cancelling') OR (status='queued' AND (attempt>0 OR EXISTS(SELECT 1 FROM ai_dispatches d WHERE d.run_id=ai_runs.run_id)))" } else { "SELECT run_id FROM ai_runs WHERE status IN ('queued','running','cancelling')" }))?;
            safe(stmt.query_map([], |r| r.get(0)))?
                .map(safe)
                .collect::<Result<_>>()?
        };
        for run in ids {
            safe(tx.execute("UPDATE ai_runs SET status='interrupted',error='WORKER_INTERRUPTED',fence=NULL WHERE run_id=?1",[&run]))?;
            safe(tx.execute(
                "UPDATE ai_attempts SET status='interrupted' WHERE run_id=?1",
                [&run],
            ))?;
            safe(tx.execute("UPDATE application_execution_bindings SET applicability='cancelled' WHERE run_id=?1 AND applicability='pending'",[&run]))?;
            let current = Self::ai_run(&tx, &run)?;
            safe(tx.execute(
                "INSERT OR IGNORE INTO ai_consumer_cleanup VALUES(?1,?2)",
                params![run, current.consumer],
            ))?;
            Self::ai_event(&tx, &current)?;
        }
        if !original {
            safe(tx.execute(
                "UPDATE ai_execution_origin SET origin_id=?1,watermark=0",
                [uuid::Uuid::new_v4().to_string()],
            ))?;
        }
        safe(tx.commit())?;
        self.origin_write(&c)
    }
}
