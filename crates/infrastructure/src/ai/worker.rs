//! Trusted Node host supervision, bounded framed pipes and scoped artifact transfer.
use super::*;
use crate::SqliteProjectRepository;
use base64::{Engine, engine::general_purpose::STANDARD};
use scenesparrow_application::ai::{AiExecutionPort, CredentialLease};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 4 * 1024 * 1024;
fn send(pipe: &mut impl Write, value: &serde_json::Value) -> Result<()> {
    let body = safe(serde_json::to_vec(value))?;
    ensure(body.len() <= MAX_FRAME, "PROTOCOL_MISMATCH")?;
    safe(pipe.write_all(&(body.len() as u32).to_be_bytes()))?;
    safe(pipe.write_all(&body))?;
    safe(pipe.flush())
}
fn artifact(pipe: &mut impl Write, manifest: &AiArtifact, bytes: &[u8]) -> Result<()> {
    ensure(
        bytes.len() as i64 == manifest.size && hash(bytes) == manifest.hash,
        "ARTIFACT_MISMATCH",
    )?;
    for chunk in bytes.chunks(24576) {
        send(
            pipe,
            &serde_json::json!({"type":"artifact_chunk","id":manifest.id,"data":STANDARD.encode(chunk)}),
        )?;
    }
    send(
        pipe,
        &serde_json::json!({"type":"artifact_end","artifact":manifest}),
    )
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[derive(Clone, Copy)]
pub enum WorkerOperation {
    Generate,
    Discover,
}
/// No untrusted path is accepted: worker location belongs to installed application code.
#[allow(clippy::too_many_arguments)]
pub fn run_worker(
    run: &AiRun,
    fence: &str,
    lease: CredentialLease,
    input_bytes: &[u8],
    artifacts: &BTreeMap<String, Vec<u8>>,
    operation: WorkerOperation,
    permit: &mut dyn FnMut() -> Result<()>,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<(AiCompletion, Vec<u8>)> {
    run_worker_at(
        run,
        fence,
        lease,
        input_bytes,
        artifacts,
        operation,
        permit,
        cancelled,
        None,
    )
}
#[allow(clippy::too_many_arguments)]
fn run_worker_at(
    run: &AiRun,
    fence: &str,
    lease: CredentialLease,
    input_bytes: &[u8],
    artifacts: &BTreeMap<String, Vec<u8>>,
    operation: WorkerOperation,
    permit: &mut dyn FnMut() -> Result<()>,
    cancelled: &mut dyn FnMut() -> bool,
    launch: Option<&std::path::Path>,
) -> Result<(AiCompletion, Vec<u8>)> {
    let mut diagnostics =
        crate::diagnostics::WorkerSummary::new(Some(match run.configuration.category {
            AiCategory::Text => "text",
            AiCategory::Audio => "audio",
            AiCategory::Video => "video",
        }));
    let input: AiInput = safe(serde_json::from_slice(input_bytes))?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut command = Command::new("node");
    command
        .arg("--use-system-ca")
        .arg("--use-env-proxy")
        .arg("--max-old-space-size=256")
        .arg(
            launch
                .map(std::path::Path::to_path_buf)
                .unwrap_or_else(|| root.join("workers/agent/src/entry.mjs")),
        );
    command.current_dir(root).env_clear();
    for name in [
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
        "NODE_USE_SYSTEM_CA",
        "NODE_EXTRA_CA_CERTS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // No OPENAI_LOG, API keys, service token, project directory or NODE_OPTIONS.
    let mut child = Child(safe(
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn(),
    )?);
    let mut stdin = child.0.stdin.take().ok_or(AiError("WORKER_INTERRUPTED"))?;
    let mut stdout = child.0.stdout.take().ok_or(AiError("WORKER_INTERRUPTED"))?;
    let (sender, receiver) = mpsc::sync_channel(16);
    let reader = std::thread::spawn(move || {
        loop {
            let frame = (|| {
                let mut length = [0; 4];
                stdout
                    .read_exact(&mut length)
                    .map_err(|_| AiError("WORKER_INTERRUPTED"))?;
                let length = u32::from_be_bytes(length) as usize;
                ensure(length > 0 && length <= MAX_FRAME, "PROTOCOL_MISMATCH")?;
                let mut bytes = vec![0; length];
                stdout
                    .read_exact(&mut bytes)
                    .map_err(|_| AiError("WORKER_INTERRUPTED"))?;
                serde_json::from_slice::<AiWorkerEvent>(&bytes)
                    .map_err(|_| AiError("PROTOCOL_MISMATCH"))
            })();
            let failed = frame.is_err();
            if sender.send(frame).is_err() || failed {
                break;
            }
        }
    });
    let deadline =
        Instant::now() + Duration::from_millis(run.configuration.policy.overall_ms as u64);
    let (written, write_result) = mpsc::sync_channel(1);
    let transfer_run = run.clone();
    let transfer_fence = fence.to_owned();
    let transfer_bytes = input_bytes.to_vec();
    let transfer_artifacts = artifacts.clone();
    let writer = std::thread::spawn(move || {
        let run = &transfer_run;
        let fence = transfer_fence.as_str();
        let input_bytes = transfer_bytes.as_slice();
        let artifacts = &transfer_artifacts;
        let result = (|| {
            send(
                &mut stdin,
                &serde_json::json!({"type":"start","protocolVersion":1,"runId":run.run_id,"attempt":run.attempt,"fence":fence,"inputHash":run.input_hash,"configuration":run.configuration,"operation":match operation { WorkerOperation::Generate=>"generate",WorkerOperation::Discover=>"discover" }}),
            )?;
            artifact(
                &mut stdin,
                &AiArtifact {
                    id: run.run_id.clone(),
                    hash: run.input_hash.clone(),
                    mime: AiArtifactMime::Applicationjson,
                    size: input_bytes.len() as i64,
                },
                input_bytes,
            )?;
            for a in &input.input_artifacts {
                artifact(
                    &mut stdin,
                    a,
                    artifacts.get(&a.id).ok_or(AiError("ARTIFACT_MISMATCH"))?,
                )?;
            }
            send(
                &mut stdin,
                &serde_json::json!({"type":"credential_lease","runId":run.run_id,"fence":fence,"secret":lease.expose()}),
            )?;
            drop(lease);
            Ok(stdin)
        })();
        let _ = written.send(result);
    });
    let mut stdin = None;
    let input: AiInput = safe(serde_json::from_slice(input_bytes))?;
    let result = (|| {
        let mut output = vec![];
        let mut permitted = false;
        let mut ready = false;
        let mut preview = 0usize;
        let mut started = false;
        let mut events = 0usize;
        loop {
            if stdin.is_none() {
                match write_result.try_recv() {
                    Ok(result) => stdin = Some(result?),
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(_) => return Err(AiError("WORKER_INTERRUPTED")),
                }
            }
            if cancelled() {
                return Err(AiError("CANCELLED"));
            }
            ensure(Instant::now() < deadline, "REQUEST_TIMEOUT")?;
            if ready
                && !permitted
                && let Some(pipe) = stdin.as_mut()
            {
                permit()?;
                permitted = true;
                send(
                    pipe,
                    &serde_json::json!({"type":"dispatch_permit","runId":run.run_id,"fence":fence}),
                )?;
            }
            #[cfg(target_os = "linux")]
            if let Ok(status) = std::fs::read_to_string(format!("/proc/{}/status", child.0.id())) {
                let rss = status
                    .lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0);
                ensure(rss <= 512 * 1024, "WORKER_RESOURCE_LIMIT")?;
            }
            let event = match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(event) => event?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err(AiError("WORKER_INTERRUPTED")),
            };
            events += 1;
            ensure(events <= 100000, "PROTOCOL_MISMATCH")?;
            match event {
                AiWorkerEvent::Started {
                    run_id,
                    attempt,
                    fence: received,
                } => {
                    ensure(
                        !started
                            && run_id == run.run_id
                            && attempt == run.attempt
                            && received == fence,
                        "PROTOCOL_MISMATCH",
                    )?;
                    started = true;
                }
                AiWorkerEvent::Progress { run_id, phase } => {
                    ensure(
                        started
                            && run_id == run.run_id
                            && word(&phase) == "dispatch_ready"
                            && !ready,
                        "PROTOCOL_MISMATCH",
                    )?;
                    ready = true;
                }
                AiWorkerEvent::OutputDelta { text } => {
                    ensure(permitted && text.len() <= 32768, "PROTOCOL_MISMATCH")?;
                    preview += text.len();
                    ensure(preview <= 262144, "PROTOCOL_MISMATCH")?;
                }
                AiWorkerEvent::OutputChunk { data } => {
                    ensure(permitted && data.len() <= 65536, "PROTOCOL_MISMATCH")?;
                    let chunk = STANDARD
                        .decode(data)
                        .map_err(|_| AiError("PROTOCOL_MISMATCH"))?;
                    ensure(
                        output.len() + chunk.len() <= input.output_spec.max_bytes as usize,
                        "OUTPUT_SIZE_LIMIT",
                    )?;
                    output.extend(chunk);
                }
                AiWorkerEvent::Usage { usage } => {
                    ensure(
                        permitted
                            && usage.input_tokens.is_none_or(|n| n >= 0)
                            && usage.output_tokens.is_none_or(|n| n >= 0),
                        "PROTOCOL_MISMATCH",
                    )?;
                }
                AiWorkerEvent::Completed { receipt } => {
                    ensure(
                        permitted
                            && receipt.run_id == run.run_id
                            && receipt.attempt == run.attempt
                            && receipt.fence == fence
                            && receipt.input_hash == run.input_hash
                            && receipt.output_hash == hash(&output),
                        "PROTOCOL_MISMATCH",
                    )?;
                    return Ok((receipt, output));
                }
                AiWorkerEvent::Failed { code } => return Err(AiError(safe_code(&code))),
            }
        }
    })();
    drop(stdin);
    let _ = child.0.kill();
    let _ = child.0.wait();
    drop(receiver);
    drop(write_result);
    let _ = writer.join();
    let _ = reader.join();
    diagnostics.finish(result.is_ok());
    result
}
pub fn safe_code(code: &str) -> &'static str {
    const CODES: &[&str] = &[
        "AUTH_REQUIRED",
        "AUTH_REJECTED",
        "ACCESS_REJECTED",
        "MODEL_LIST_NOT_FOUND",
        "MODEL_LIST_UNSUPPORTED",
        "QUOTA_EXCEEDED",
        "PROVIDER_SERVER_FAILED",
        "CREDENTIAL_UNAVAILABLE",
        "MODEL_UNAVAILABLE",
        "CAPABILITY_UNSUPPORTED",
        "CONFIGURATION_STALE",
        "SETTINGS_CONFLICT",
        "QUEUE_FULL",
        "RATE_LIMITED",
        "CONTEXT_LIMIT",
        "OUTPUT_TRUNCATED",
        "OUTPUT_TOKEN_LIMIT",
        "OUTPUT_SIZE_LIMIT",
        "INVALID_OUTPUT",
        "PROVIDER_REFUSED",
        "PROVIDER_REJECTED",
        "NETWORK_FAILED",
        "REQUEST_TIMEOUT",
        "WORKER_INTERRUPTED",
        "CANCELLED",
        "PROTOCOL_MISMATCH",
        "INPUT_TOO_LARGE",
        "INVALID_OUTPUT_SCHEMA",
        "ARTIFACT_MISMATCH",
        "ENDPOINT_REDIRECT",
        "WORKER_RESOURCE_LIMIT",
        "INVALID_INPUT",
        "INVALID_URL",
    ];
    CODES
        .iter()
        .copied()
        .find(|v| *v == code)
        .unwrap_or("WORKER_INTERRUPTED")
}
impl SqliteProjectRepository {
    /// A host tick claims at most one queued task; no retry loop exists.
    pub fn execute_next_ai(&self, settings: &settings::SettingsStore) -> Result<Option<AiRun>> {
        let _worker = self.worker_guard();
        let Some((run, fence)) = self.claim_ai()? else {
            return Ok(None);
        };
        let result = (|| {
            let lease = settings.lease(&run.configuration)?;
            let (bytes, artifacts) = self.ai_input_bytes(&run)?;
            let (receipt, output) = run_worker(
                &run,
                &fence,
                lease,
                &bytes,
                &artifacts,
                WorkerOperation::Generate,
                &mut || self.dispatch_ai(&run.run_id, run.attempt, &fence, &run.input_hash),
                &mut || {
                    self.is_quiescing()
                        || self.read_run(&run.run_id).is_ok_and(|r| {
                            matches!(r.status, AiRunStatus::Cancelled | AiRunStatus::Interrupted)
                        })
                },
            )?;
            self.complete_ai(&receipt, &output)
        })();
        match result {
            Ok(run) => Ok(Some(run)),
            Err(error) => self.fail_ai(&run.run_id, &fence, error.0).map(Some),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{config, configured, input};
    use super::*;
    #[test]
    fn provider_status_codes_survive_without_arbitrary_worker_details() {
        for code in [
            "AUTH_REJECTED",
            "ACCESS_REJECTED",
            "MODEL_LIST_NOT_FOUND",
            "MODEL_LIST_UNSUPPORTED",
            "QUOTA_EXCEEDED",
            "RATE_LIMITED",
            "PROVIDER_SERVER_FAILED",
            "OUTPUT_TRUNCATED",
            "OUTPUT_TOKEN_LIMIT",
            "OUTPUT_SIZE_LIMIT",
        ] {
            assert_eq!(safe_code(code), code);
        }
        assert_eq!(safe_code("SECRET_VENDOR_BODY"), "WORKER_INTERRUPTED");
    }
    #[test]
    fn startup_artifact_pipe_timeout_cancel_and_protocol_overflow_are_supervised() {
        let directory = tempfile::tempdir().unwrap();
        let settings = settings::SettingsStore::open(directory.path()).unwrap();
        configured(&settings, "none");
        let mut configuration = config(&settings);
        configuration.policy.overall_ms = 350;
        let mut input = input();
        let bytes = vec![1; 4194304];
        let id = uuid::Uuid::new_v4().to_string();
        input.input_artifacts.push(AiArtifact {
            id: id.clone(),
            hash: hash(&bytes),
            mime: AiArtifactMime::Imagepng,
            size: bytes.len() as i64,
        });
        let input_bytes = serde_json::to_vec(&input).unwrap();
        let run = AiRun {
            usage: None,
            run_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            input_hash: hash(&input_bytes),
            configuration,
            status: AiRunStatus::Running,
            attempt: 1,
            error: None,
            result: None,
            retry_of_run_id: None,
            consumer: "fixture".into(),
            binding_id: uuid::Uuid::new_v4().to_string(),
        };
        let fence = uuid::Uuid::new_v4().to_string();
        let artifacts = BTreeMap::from([(id, bytes)]);
        let shim = directory.path().join("nonreading.mjs");
        std::fs::write(&shim, "setInterval(() => {}, 1000);").unwrap();
        let started = Instant::now();
        let mut permits = 0;
        let error = run_worker_at(
            &run,
            &fence,
            CredentialLease::new(Some("SYNTHETIC_HANG_CANARY".into())),
            &input_bytes,
            &artifacts,
            WorkerOperation::Generate,
            &mut || {
                permits += 1;
                Ok(())
            },
            &mut || false,
            Some(&shim),
        )
        .unwrap_err();
        assert_eq!(error.0, "REQUEST_TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(permits, 0);
        let started = Instant::now();
        let error = run_worker_at(
            &run,
            &fence,
            CredentialLease::new(None),
            &input_bytes,
            &artifacts,
            WorkerOperation::Generate,
            &mut || panic!(),
            &mut || started.elapsed() > Duration::from_millis(40),
            Some(&shim),
        )
        .unwrap_err();
        assert_eq!(error.0, "CANCELLED");
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::write(&shim,"const b=Buffer.alloc(4);b.writeUInt32BE(4194305);process.stdout.write(b);setInterval(()=>{},1000);").unwrap();
        let error = run_worker_at(
            &run,
            &fence,
            CredentialLease::new(None),
            &input_bytes,
            &artifacts,
            WorkerOperation::Generate,
            &mut || panic!(),
            &mut || false,
            Some(&shim),
        )
        .unwrap_err();
        assert_eq!(error.0, "PROTOCOL_MISMATCH");
        #[cfg(target_os = "linux")]
        {
            let mut memory_run = run.clone();
            memory_run.configuration.policy.overall_ms = 5000;
            std::fs::write(
                &shim,
                "globalThis.payload=Buffer.alloc(600*1024*1024,1);setInterval(()=>{},1000);",
            )
            .unwrap();
            let started = Instant::now();
            let error = run_worker_at(
                &memory_run,
                &fence,
                CredentialLease::new(None),
                &input_bytes,
                &artifacts,
                WorkerOperation::Generate,
                &mut || panic!("memory-limited shim cannot dispatch"),
                &mut || false,
                Some(&shim),
            )
            .unwrap_err();
            assert_eq!(error.0, "WORKER_RESOURCE_LIMIT");
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }
}
