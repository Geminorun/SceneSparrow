use super::*;
use crate::SqliteProjectRepository;
use scenesparrow_application::{ProjectRepository, ai::*};
use settings::SettingsStore;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn evidence() -> AiEvidence {
    AiEvidence {
        state: AiEvidenceState::Unknown,
        source: AiEvidenceSource::Unknown,
        scope: "".into(),
        observed_at: None,
    }
}
pub(crate) fn configured(store: &SettingsStore, auth: &str) -> AiSettingsView {
    let mut view = store.read_settings().unwrap();
    let id = uuid();
    view.settings.providers.push(AiProvider {
        service_preset: None,
        id: id.clone(),
        label: "Fixture".into(),
        adapter: AiProviderAdapter::Openaicompatible,
        base_url: "http://127.0.0.1:1/custom".into(),
        auth_mode: serde_json::from_str(&format!("\"{auth}\"")).unwrap(),
        credential_revision: None,
        revision: 1,
    });
    view.settings.models.push(AiModel {
        default_parameters: None,
        provider_id: id.clone(),
        id: "manual-model".into(),
        label: "Manual".into(),
        capabilities: AiCapabilities {
            images: evidence(),
            streaming: evidence(),
            native_json: evidence(),
        },
        context_tokens: None,
        output_tokens: None,
        token_field: AiModelTokenField::Maxtokens,
    });
    view.settings.bindings.push(AiBinding {
        category: AiCategory::Text,
        provider_id: id,
        model_id: "manual-model".into(),
        parameters: AiParameters {
            temperature_milli: None,
            max_output_tokens: 64,
            request_streaming: true,
            request_native_json: true,
        },
        revision: 1,
    });
    store
        .update_settings(&AiSettingsUpdate {
            expected_revision: view.settings.revision,
            settings: view.settings,
        })
        .unwrap()
}
pub(super) fn config(store: &SettingsStore) -> AiResolvedConfig {
    store
        .resolve_configuration(AiCategory::Text, AiCapability::Textgenerate)
        .unwrap()
        .configuration
}
pub(super) fn input() -> AiInput {
    AiInput {
        protocol_version: 1,
        messages: vec![AiMessage {
            role: AiMessageRole::User,
            content: vec![AiPart::Text {
                text: "Independent numerical fixture".into(),
            }],
        }],
        input_artifacts: vec![],
        output_spec: AiOutputSpec {
            mime: AiOutputSpecMime::Textplain,
            schema_id: "fixture/result/1".into(),
            schema_version: 1,
            schema_artifact_id: None,
            max_bytes: 8388608,
        },
        image_decision: AiInputImageDecision::None,
    }
}
struct Owner;
impl ConsumerCoordinator for Owner {
    fn name(&self) -> &str {
        "numeric-fixture"
    }
    fn cancel(&self, uow: &mut dyn ProjectUnitOfWork, run: &AiRun) -> Result<bool> {
        uow.fence_consumer(self.name(), &run.binding_id)
    }
}
fn project() -> (tempfile::TempDir, SqliteProjectRepository) {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    repo.create("fixture", "Independent fixture").unwrap();
    repo.register_ai_consumer(Arc::new(Owner)).unwrap();
    (dir, repo)
}
fn start(repo: &SqliteProjectRepository, store: &SettingsStore) -> AiStart {
    let request_id = uuid();
    let h = repo
        .prepare_ai_input(&request_id, &input(), &BTreeMap::new())
        .unwrap();
    AiStart {
        request_id,
        run_id: uuid(),
        fingerprint: config(store).fingerprint,
        input_hash: h,
        consumer: "numeric-fixture".into(),
        binding_id: uuid(),
        retry_of_run_id: None,
    }
}
fn accept(repo: &SqliteProjectRepository, store: &SettingsStore, s: &AiStart) -> AiRun {
    repo.accept_ai(store, s, &mut |tx, run| {
        tx.stage_consumer_record(
            &run.consumer,
            &run.binding_id,
            &run.run_id,
            "opaque numeric reservation",
        )
    })
    .unwrap()
}
fn completion(run: &AiRun, fence: &str, bytes: &[u8]) -> AiCompletion {
    AiCompletion {
        run_id: run.run_id.clone(),
        attempt: run.attempt,
        fence: fence.into(),
        input_hash: run.input_hash.clone(),
        output_hash: hash(bytes),
        finish_reason: AiCompletionFinishReason::Stop,
        usage: None,
    }
}

#[test]
fn global_revision_lock_atomic_profile_delete_url_and_semantic_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let a = SettingsStore::open(dir.path()).unwrap();
    let b = SettingsStore::open(dir.path()).unwrap();
    let first = configured(&a, "none");
    let frozen = config(&a);
    assert!(!frozen.stream && !frozen.native_json);
    let mut changed = first.settings.clone();
    changed.providers[0].label = "Display only".into();
    let latest = a
        .update_settings(&AiSettingsUpdate {
            expected_revision: first.settings.revision,
            settings: changed.clone(),
        })
        .unwrap();
    assert_eq!(frozen.fingerprint, config(&a).fingerprint);
    assert_eq!(
        b.update_settings(&AiSettingsUpdate {
            expected_revision: first.settings.revision,
            settings: changed
        })
        .unwrap_err()
        .0,
        "SETTINGS_CONFLICT"
    );
    for root in [
        "https://user:secret@example.com/v1",
        "https://example.com/v1?api_key=secret",
        "file:///tmp/key",
    ] {
        assert_eq!(validate_root(root).unwrap_err().0, "INVALID_URL")
    }
    let deleted_id = latest.settings.providers[0].id.clone();
    let mut s = latest.settings.clone();
    s.providers.clear();
    let deleted = a
        .update_settings(&AiSettingsUpdate {
            expected_revision: s.revision,
            settings: s,
        })
        .unwrap();
    assert!(deleted.settings.models.is_empty() && deleted.settings.bindings.is_empty());
    let mut recycled = first.settings;
    recycled.revision = deleted.settings.revision;
    assert_eq!(
        a.update_settings(&AiSettingsUpdate {
            expected_revision: deleted.settings.revision,
            settings: recycled
        })
        .unwrap_err()
        .0,
        "INVALID_SETTINGS"
    );
    assert!(deleted.settings.retired_profile_ids.contains(&deleted_id));
    let bytes = std::fs::read(dir.path().join("ai-settings.json")).unwrap();
    let read: AiSettings = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(read, deleted.settings);
}
#[derive(Default)]
struct Vault {
    entries: Mutex<BTreeMap<String, String>>,
    delete_fails: AtomicBool,
    put_fails_after_insert: AtomicBool,
}
impl CredentialStore for Vault {
    fn put_new_revision(&self, id: &str, secret: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap()
            .insert(id.into(), secret.into());
        if self.put_fails_after_insert.load(Ordering::SeqCst) {
            return Err(AiError("CREDENTIAL_UNAVAILABLE"));
        }
        Ok(())
    }
    fn acquire_scoped_lease(&self, id: &str) -> Result<CredentialLease> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .map(|s| CredentialLease::new(Some(s)))
            .ok_or(AiError("CREDENTIAL_UNAVAILABLE"))
    }
    fn delete(&self, id: &str) -> Result<()> {
        if self.delete_fails.load(Ordering::SeqCst) {
            return Err(AiError("CREDENTIAL_UNAVAILABLE"));
        }
        self.entries.lock().unwrap().remove(id);
        Ok(())
    }
    fn present(&self, id: &str) -> bool {
        self.entries.lock().unwrap().contains_key(id)
    }
    fn persistent(&self) -> bool {
        true
    }
}
#[test]
fn credential_rotation_retirement_orphan_inventory_and_session_restart_are_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(Vault::default());
    let store = SettingsStore::with_credentials(dir.path(), vault.clone()).unwrap();
    let first = configured(&store, "bearer");
    let id = first.settings.providers[0].id.clone();
    let first = store
        .update_credential(
            first.settings.revision,
            &id,
            Some("SYNTHETIC_CREDENTIAL_CANARY_A"),
        )
        .unwrap();
    let old = config(&store);
    let lease = store.lease(&old).unwrap();
    vault.delete_fails.store(true, Ordering::SeqCst);
    let rotated = store
        .update_credential(
            first.settings.revision,
            &id,
            Some("SYNTHETIC_CREDENTIAL_CANARY_B"),
        )
        .unwrap();
    assert_eq!(lease.expose(), Some("SYNTHETIC_CREDENTIAL_CANARY_A"));
    assert_eq!(store.lease(&old).err().unwrap().0, "CREDENTIAL_UNAVAILABLE");
    assert_eq!(vault.entries.lock().unwrap().len(), 2);
    for path in ["ai-settings.json", "owned-credential-revisions.json"] {
        assert!(
            !std::fs::read_to_string(dir.path().join(path))
                .unwrap()
                .contains("SYNTHETIC_CREDENTIAL_CANARY")
        );
    }
    drop(store);
    vault.delete_fails.store(false, Ordering::SeqCst);
    let reopened = SettingsStore::with_credentials(dir.path(), vault.clone()).unwrap();
    assert_eq!(vault.entries.lock().unwrap().len(), 1);
    vault.put_fails_after_insert.store(true, Ordering::SeqCst);
    vault.delete_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        reopened
            .update_credential(
                rotated.settings.revision,
                &id,
                Some("SYNTHETIC_ORPHAN_CANARY")
            )
            .err()
            .unwrap()
            .0,
        "CREDENTIAL_UNAVAILABLE"
    );
    drop(reopened);
    assert_eq!(vault.entries.lock().unwrap().len(), 2);
    vault.put_fails_after_insert.store(false, Ordering::SeqCst);
    vault.delete_fails.store(false, Ordering::SeqCst);
    let reconciled = SettingsStore::with_credentials(dir.path(), vault.clone()).unwrap();
    assert_eq!(vault.entries.lock().unwrap().len(), 1);
    let deleted = reconciled
        .update_credential(rotated.settings.revision, &id, None)
        .unwrap();
    assert!(deleted.present_credential_revisions.is_empty());
    assert!(vault.entries.lock().unwrap().is_empty());
    let session_dir = tempfile::tempdir().unwrap();
    let session = SettingsStore::open(session_dir.path()).unwrap();
    let first = configured(&session, "bearer");
    session
        .update_credential(
            first.settings.revision,
            &first.settings.providers[0].id,
            Some("SESSION_ONLY_SYNTHETIC_CANARY"),
        )
        .unwrap();
    assert!(
        session.read_settings().unwrap().credential_backend
            == AiSettingsViewCredentialBackend::Sessiononly
    );
    drop(session);
    let lost = SettingsStore::open(session_dir.path()).unwrap();
    assert_eq!(
        lost.resolve_configuration(AiCategory::Text, AiCapability::Textgenerate)
            .unwrap_err()
            .0,
        "CREDENTIAL_UNAVAILABLE"
    );
}
#[test]
fn independent_consumer_start_is_atomic_idempotent_and_configuration_checked_before_commit() {
    let (_dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let s = start(&repo, &settings);
    let error = repo
        .accept_ai(&settings, &s, &mut |tx, r| {
            tx.stage_consumer_record(&r.consumer, &r.binding_id, &r.run_id, "reservation")?;
            Err(AiError("INJECTED_FAILURE"))
        })
        .unwrap_err();
    assert_eq!(error.0, "INJECTED_FAILURE");
    let c = repo.connection.lock().unwrap();
    for table in [
        "ai_runs",
        "ai_input_snapshots",
        "application_execution_bindings",
        "ai_events",
    ] {
        assert_eq!(
            c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        )
    }
    drop(c);
    let run = accept(&repo, &settings, &s);
    let mut view = settings.read_settings().unwrap();
    view.settings.policy.idle_ms -= 1;
    settings
        .update_settings(&AiSettingsUpdate {
            expected_revision: view.settings.revision,
            settings: view.settings,
        })
        .unwrap();
    let replay = repo
        .accept_ai(&settings, &s, &mut |_, _| {
            panic!("duplicate must not rerun consumer preconditions")
        })
        .unwrap();
    assert_eq!(run, replay);
    let mut altered = s.clone();
    altered.binding_id = uuid();
    assert_eq!(
        repo.accept_ai(&settings, &altered, &mut |_, _| Ok(()))
            .unwrap_err()
            .0,
        "REQUEST_ID_REUSED"
    );
    let mut stale = start(&repo, &settings);
    stale.fingerprint = s.fingerprint;
    assert_eq!(
        repo.accept_ai(&settings, &stale, &mut |_, _| Ok(()))
            .unwrap_err()
            .0,
        "CONFIGURATION_STALE"
    );
    assert_eq!(
        repo.read_run(&s.run_id).unwrap().configuration,
        run.configuration
    );
    assert!(
        std::fs::read_dir(sd.path())
            .unwrap()
            .all(|e| !repo.directory.starts_with(e.unwrap().path()))
    );
}
#[test]
fn dispatch_and_completion_are_lifetime_fenced_and_result_application_is_separate() {
    let (_dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let s = start(&repo, &settings);
    accept(&repo, &settings, &s);
    let (run, fence) = repo.claim_ai().unwrap().unwrap();
    assert!(repo.claim_ai().unwrap().is_none());
    assert_eq!(
        repo.dispatch_ai(&run.run_id, 1, &uuid(), &run.input_hash)
            .unwrap_err()
            .0,
        "STALE_ATTEMPT"
    );
    repo.dispatch_ai(&run.run_id, 1, &fence, &run.input_hash)
        .unwrap();
    assert_eq!(
        repo.dispatch_ai(&run.run_id, 1, &fence, &run.input_hash)
            .unwrap_err()
            .0,
        "DISPATCH_ALREADY_MARKED"
    );
    let mut receipt = completion(&run, &fence, b"42");
    receipt.usage = Some(AiUsage {
        input_tokens: Some(5),
        output_tokens: Some(2),
    });
    let done = repo.complete_ai(&receipt, b"42").unwrap();
    assert_eq!(done.status, AiRunStatus::Succeeded);
    assert_eq!(done.usage, receipt.usage);
    assert_eq!(repo.complete_ai(&receipt, b"42").unwrap(), done);
    let mut wrong = receipt.clone();
    wrong.output_hash = hash(b"43");
    assert_eq!(
        repo.complete_ai(&wrong, b"43").unwrap_err().0,
        "STALE_RECEIPT"
    );
    assert_eq!(
        repo.complete_ai(&receipt, b"tamper").unwrap_err().0,
        "ARTIFACT_MISMATCH"
    );
    assert_eq!(
        repo.prune_ai_payload(&run.run_id).unwrap_err().0,
        "ARTIFACT_PINNED"
    );
    let cancelled = repo.cancel_ai(&run.run_id, &[]).unwrap();
    assert_eq!(cancelled.status, AiRunStatus::Succeeded);
    assert_eq!(
        repo.apply_ai_consumer("numeric-fixture", &run.binding_id, &mut |_, _| Ok(()))
            .unwrap_err()
            .0,
        "CONSUMER_CANCELLED"
    );
    repo.prune_ai_payload(&run.run_id).unwrap();
    repo.collect_objects(Duration::ZERO).unwrap();
    assert!(repo.read_result(&run.run_id).is_err());
    assert_eq!(
        repo.accept_ai(&settings, &s, &mut |_, _| panic!())
            .unwrap()
            .status,
        AiRunStatus::Succeeded
    );
}
#[test]
fn cancel_before_completion_and_application_winner_are_serialized() {
    let (_dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let s = start(&repo, &settings);
    accept(&repo, &settings, &s);
    let (run, fence) = repo.claim_ai().unwrap().unwrap();
    repo.dispatch_ai(&run.run_id, 1, &fence, &run.input_hash)
        .unwrap();
    repo.cancel_ai(&run.run_id, &[]).unwrap();
    assert_eq!(
        repo.complete_ai(&completion(&run, &fence, b"42"), b"42")
            .unwrap_err()
            .0,
        "STALE_RECEIPT"
    );
    let s = start(&repo, &settings);
    accept(&repo, &settings, &s);
    let (run, fence) = repo.claim_ai().unwrap().unwrap();
    repo.dispatch_ai(&run.run_id, 1, &fence, &run.input_hash)
        .unwrap();
    repo.complete_ai(&completion(&run, &fence, b"42"), b"42")
        .unwrap();
    let mut calls = 0;
    repo.apply_ai_consumer("numeric-fixture", &run.binding_id, &mut |_, _| {
        calls += 1;
        Ok(())
    })
    .unwrap();
    repo.apply_ai_consumer("numeric-fixture", &run.binding_id, &mut |_, _| panic!())
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(
        repo.cancel_ai(&run.run_id, &[]).unwrap_err().0,
        "ALREADY_APPLIED"
    );
}
#[test]
fn original_restart_keeps_only_unclaimed_queue_and_copy_or_old_restore_fences_every_queue() {
    let (dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let first = start(&repo, &settings);
    accept(&repo, &settings, &first);
    let queued = start(&repo, &settings);
    accept(&repo, &settings, &queued);
    // Consistent snapshot with both queued: it might be executed in the original later.
    let copy = tempfile::tempdir().unwrap();
    std::fs::create_dir(copy.path().join("objects")).unwrap();
    {
        let c = repo.connection.lock().unwrap();
        let mut target = rusqlite::Connection::open(copy.path().join("project.sqlite")).unwrap();
        rusqlite::backup::Backup::new(&c, &mut target)
            .unwrap()
            .run_to_completion(32, Duration::from_millis(1), None)
            .unwrap();
        for e in std::fs::read_dir(dir.path().join("objects")).unwrap() {
            let e = e.unwrap();
            std::fs::copy(e.path(), copy.path().join("objects").join(e.file_name())).unwrap();
        }
    }
    let (run, fence) = repo.claim_ai().unwrap().unwrap();
    repo.dispatch_ai(&run.run_id, 1, &fence, &run.input_hash)
        .unwrap();
    drop(repo);
    let original = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        original.read_run(&run.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert_eq!(
        original.read_run(&queued.run_id).unwrap().status,
        AiRunStatus::Queued
    );
    original.register_ai_consumer(Arc::new(Owner)).unwrap();
    drop(original);
    let native_id = file_id::get_file_id(dir.path().join("project.sqlite")).unwrap();
    {
        let snapshot = rusqlite::Connection::open(copy.path().join("project.sqlite")).unwrap();
        let mut live = rusqlite::Connection::open(dir.path().join("project.sqlite")).unwrap();
        rusqlite::backup::Backup::new(&snapshot, &mut live)
            .unwrap()
            .run_to_completion(32, Duration::from_millis(1), None)
            .unwrap();
    }
    assert_eq!(
        native_id,
        file_id::get_file_id(dir.path().join("project.sqlite")).unwrap()
    );
    let restored = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        restored.read_run(&queued.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert!(restored.claim_ai().unwrap().is_none());
    let recovered = SqliteProjectRepository::open(copy.path()).unwrap();
    assert_eq!(
        recovered.read_run(&first.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert_eq!(
        recovered.read_run(&queued.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert!(recovered.claim_ai().unwrap().is_none());
    recovered.register_ai_consumer(Arc::new(Owner)).unwrap();
    let retry = start(&recovered, &settings);
    let retry = AiStart {
        retry_of_run_id: Some(first.run_id.clone()),
        ..retry
    };
    recovered
        .prepare_manual_retry(&first.run_id, &retry)
        .unwrap();
    accept(&recovered, &settings, &retry);
    assert_ne!(retry.run_id, first.run_id);
}
#[test]
fn queue_limits_gc_preparations_historical_pins_and_failure_cleanup() {
    let (_dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let s = start(&repo, &settings);
    repo.collect_objects(Duration::ZERO).unwrap();
    assert!(repo.read_object(&s.input_hash).is_ok());
    accept(&repo, &settings, &s);
    for _ in 0..7 {
        let s = start(&repo, &settings);
        accept(&repo, &settings, &s);
    }
    let ninth = start(&repo, &settings);
    assert_eq!(
        repo.accept_ai(&settings, &ninth, &mut |_, _| Ok(()))
            .unwrap_err()
            .0,
        "QUEUE_FULL"
    );
    let (run, fence) = repo.claim_ai().unwrap().unwrap();
    let failed = repo.fail_ai(&run.run_id, &fence, "NETWORK_FAILED").unwrap();
    assert_eq!(failed.status, AiRunStatus::Failed);
    repo.prune_ai_payload(&run.run_id).unwrap();
    let pin = uuid();
    repo.pin_object(&pin, &run.input_hash).unwrap();
    repo.collect_objects(Duration::ZERO).unwrap();
    assert!(repo.read_object(&run.input_hash).is_ok());
    repo.unpin_objects(&pin).unwrap();
}
#[test]
fn escaped_one_mib_input_is_not_confused_with_control_frame_limit_and_schema_refs_are_scoped() {
    let (_dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let mut i = input();
    i.messages[0].content = vec![AiPart::Text {
        text: "\\".repeat(1048576),
    }];
    let req = uuid();
    let hash = repo.prepare_ai_input(&req, &i, &BTreeMap::new()).unwrap();
    assert!(repo.read_object(&hash).unwrap().len() > 2097152);
    let s = AiStart {
        request_id: req,
        run_id: uuid(),
        fingerprint: config(&settings).fingerprint,
        input_hash: hash,
        consumer: "numeric-fixture".into(),
        binding_id: uuid(),
        retry_of_run_id: None,
    };
    accept(&repo, &settings, &s);
    assert!(validate_input(&i, &config(&settings)).is_ok());
    i.messages[0]
        .content
        .push(AiPart::Text { text: "x".into() });
    assert_eq!(
        validate_input(&i, &config(&settings)).unwrap_err().0,
        "INPUT_TOO_LARGE"
    );
    assert!(!UnavailableSearch.search("x", 5).unwrap().available);
    assert_eq!(
        settings
            .resolve_configuration(AiCategory::Audio, AiCapability::Audiosynthesize)
            .unwrap_err()
            .0,
        "CAPABILITY_UNSUPPORTED"
    );
}
#[test]
fn rejected_transaction_preserves_known_queue_but_actual_origin_ahead_fences_reopen() {
    let (dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let a = start(&repo, &settings);
    accept(&repo, &settings, &a);
    let b = start(&repo, &settings);
    assert!(
        repo.accept_ai(&settings, &b, &mut |_, _| Err(AiError("INJECTED_FAILURE")))
            .is_err()
    );
    drop(repo);
    let reopened = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        reopened.read_run(&a.run_id).unwrap().status,
        AiRunStatus::Queued
    );
    assert_eq!(reopened.read_run(&b.run_id).unwrap_err().0, "RUN_NOT_FOUND");
    // Simulate power loss after the external durable fence but before the SQL
    // watermark commits. This is ambiguous, unlike an ordinary rejected request.
    {
        let connection = reopened.connection.lock().unwrap();
        reopened.ai_prepare_watermark(&connection).unwrap();
    }
    drop(reopened);
    let fenced = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        fenced.read_run(&a.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert_eq!(fenced.read_run(&b.run_id).unwrap_err().0, "RUN_NOT_FOUND");
}

#[test]
fn actual_sdk_worker_commits_one_result_and_reopen_applies_locally_without_network() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::AtomicUsize,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let counted = count.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = vec![];
        let mut b = [0; 8192];
        loop {
            let n = stream.read(&mut b).unwrap();
            assert!(n > 0);
            request.extend_from_slice(&b[..n]);
            if let Some(at) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = std::str::from_utf8(&request[..at]).unwrap();
                let size = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if request.len() >= at + 4 + size {
                    break;
                }
            }
        }
        counted.fetch_add(1, Ordering::SeqCst);
        let text = String::from_utf8(request).unwrap();
        assert!(text.starts_with("POST /custom/chat/completions HTTP/1.1"));
        assert!(!text.to_ascii_lowercase().contains("authorization:"));
        let body = r#"{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"42"}}]}"#;
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    });
    let (dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    let mut view = configured(&settings, "none");
    view.settings.providers[0].base_url = format!("http://{address}/custom");
    settings
        .update_settings(&AiSettingsUpdate {
            expected_revision: view.settings.revision,
            settings: view.settings,
        })
        .unwrap();
    let mut start = start(&repo, &settings);
    let mut escaped = input();
    escaped.messages[0].content = vec![AiPart::Text {
        text: "\\".repeat(1048576),
    }];
    start.input_hash = repo
        .prepare_ai_input(&start.request_id, &escaped, &BTreeMap::new())
        .unwrap();
    accept(&repo, &settings, &start);
    let run = repo.execute_next_ai(&settings).unwrap().unwrap();
    assert_eq!(run.status, AiRunStatus::Succeeded);
    assert_eq!(repo.read_result(&run.run_id).unwrap().unwrap(), b"42");
    assert!(repo.execute_next_ai(&settings).unwrap().is_none());
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(repo);
    let reopened = SqliteProjectRepository::open(dir.path()).unwrap();
    reopened.register_ai_consumer(Arc::new(Owner)).unwrap();
    let mut applied = 0;
    reopened
        .apply_ai_consumer("numeric-fixture", &run.binding_id, &mut |_, _| {
            applied += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(applied, 1);
    assert!(reopened.execute_next_ai(&settings).unwrap().is_none());
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn credential_reference_commit_fault_preserves_old_settings_and_reconciles_orphan() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Arc::new(Vault::default());
    let store = SettingsStore::with_credentials(directory.path(), vault.clone()).unwrap();
    let first = configured(&store, "bearer");
    let before = std::fs::read(directory.path().join("ai-settings.json")).unwrap();
    store.fail_next_write.store(true, Ordering::SeqCst);
    vault.delete_fails.store(true, Ordering::SeqCst);
    assert_eq!(
        store
            .update_credential(
                first.settings.revision,
                &first.settings.providers[0].id,
                Some("SYNTHETIC_ATOMIC_FAILURE_CANARY")
            )
            .unwrap_err()
            .0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        std::fs::read(directory.path().join("ai-settings.json")).unwrap(),
        before
    );
    assert_eq!(vault.entries.lock().unwrap().len(), 1);
    drop(store);
    vault.delete_fails.store(false, Ordering::SeqCst);
    let reopened = SettingsStore::with_credentials(directory.path(), vault.clone()).unwrap();
    assert!(vault.entries.lock().unwrap().is_empty());
    assert!(
        reopened
            .read_settings()
            .unwrap()
            .present_credential_revisions
            .is_empty()
    );
    assert_eq!(
        std::fs::read(directory.path().join("ai-settings.json")).unwrap(),
        before
    );
}
#[test]
fn verified_backup_recovered_copy_fences_every_queued_run_and_quiesce_preserves_original_undispatched_work()
 {
    let (dir, repo) = project();
    let sd = tempfile::tempdir().unwrap();
    let settings = SettingsStore::open(sd.path()).unwrap();
    configured(&settings, "none");
    let active = start(&repo, &settings);
    accept(&repo, &settings, &active);
    repo.claim_ai().unwrap().unwrap();
    let queued = start(&repo, &settings);
    accept(&repo, &settings, &queued);
    let backup = repo.verified_backup().unwrap();
    let copy =
        SqliteProjectRepository::restore_verified_copy(&backup, &dir.path().join("recovered"))
            .unwrap();
    assert_eq!(
        copy.read_run(&active.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert_eq!(
        copy.read_run(&queued.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert!(copy.claim_ai().unwrap().is_none());
    repo.quiesce().unwrap();
    assert_eq!(
        repo.read_run(&active.run_id).unwrap().status,
        AiRunStatus::Interrupted
    );
    assert_eq!(
        repo.read_run(&queued.run_id).unwrap().status,
        AiRunStatus::Queued
    );
    assert!(repo.claim_ai().unwrap().is_none());
    repo.resume();
    assert_eq!(repo.claim_ai().unwrap().unwrap().0.run_id, queued.run_id);
}

#[test]
fn model_service_metadata_legacy_compatibility_preferences_and_semantic_fingerprints() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::open(dir.path()).unwrap();
    let first = configured(&store, "none");
    let fingerprint = config(&store).fingerprint;
    let legacy_json = serde_json::to_value(&first.settings).unwrap();
    assert!(legacy_json["providers"][0].get("servicePreset").is_none());
    assert!(legacy_json["models"][0].get("defaultParameters").is_none());
    let legacy: AiSettings = serde_json::from_value(legacy_json).unwrap();
    validate_settings(&legacy).unwrap();
    let mut settings = legacy.clone();
    settings.providers[0].service_preset = Some(AiProviderServicePreset::Openai);
    let mut preferences = settings.bindings[0].parameters.clone();
    preferences.max_output_tokens = 512;
    settings.models[0].default_parameters = Some(preferences.clone());
    let saved = store
        .update_settings(&AiSettingsUpdate {
            expected_revision: first.settings.revision,
            settings,
        })
        .unwrap();
    assert_eq!(config(&store).fingerprint, fingerprint);
    assert_eq!(saved.settings.bindings, legacy.bindings);
    let mut duplicate = saved.settings.clone();
    let mut other = duplicate.providers[0].clone();
    other.id = uuid();
    duplicate.providers.push(other);
    assert_eq!(
        validate_settings(&duplicate).unwrap_err().0,
        "INVALID_SETTINGS"
    );
    let mut invalid = saved.settings.clone();
    invalid.models[0].output_tokens = Some(128);
    assert_eq!(
        validate_settings(&invalid).unwrap_err().0,
        "INVALID_SETTINGS"
    );
    let mut selected = saved.settings.clone();
    selected.bindings[0].parameters = preferences;
    let next = store
        .update_settings(&AiSettingsUpdate {
            expected_revision: saved.settings.revision,
            settings: selected,
        })
        .unwrap();
    assert_ne!(config(&store).fingerprint, fingerprint);
    assert_eq!(next.settings.providers[0].id, legacy.providers[0].id);
    assert_eq!(
        next.settings.providers[0].auth_mode,
        legacy.providers[0].auth_mode
    );
    let backend: AiSettingsViewCredentialBackend =
        serde_json::from_str("\"encrypted_file\"").unwrap();
    assert_eq!(word(&backend), "encrypted_file");
}
