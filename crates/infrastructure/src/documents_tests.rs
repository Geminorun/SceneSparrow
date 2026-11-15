use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
use serde_json::{Value, json};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn setup() -> (tempfile::TempDir, SqliteProjectRepository, String) {
    let dir = tempfile::tempdir().unwrap();
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    let p = r.create("create", "Sources/import").unwrap();
    (dir, r, p.id)
}
fn cmd(r: &SqliteProjectRepository, p: &str, kind: &str, payload: Value) -> ManuscriptCommand {
    serde_json::from_value(json!({"type":kind,"requestId":id(),"projectId":p,"expectedWorkingRevision":r.read_manuscript().unwrap().working_revision,"payload":payload})).unwrap()
}
fn history(r: &SqliteProjectRepository, p: &str, kind: &str) -> ManuscriptCommand {
    let h = r.read_history().unwrap();
    serde_json::from_value(json!({"type":kind,"requestId":id(),"projectId":p,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap()
}
fn upload(r: &SqliteProjectRepository, name: &str, bytes: &[u8]) -> Intake {
    let id = id();
    r.begin_intake(&id, name, "application/octet-stream")
        .unwrap();
    for chunk in bytes.chunks(4096) {
        r.append_intake(&id, chunk).unwrap();
    }
    r.complete_intake(&id).unwrap()
}
fn prepare(r: &SqliteProjectRepository, text: &str) -> DocumentJob {
    let id = id();
    r.document_action(&DocumentAction::PreparePaste {
        job_id: id.clone(),
        text: text.into(),
        expected_working_revision: r.read_manuscript().unwrap().working_revision,
    })
    .unwrap();
    r.run_document(&id).unwrap();
    r.document_job(&id).unwrap()
}
fn commit(r: &SqliteProjectRepository, p: &str, j: &DocumentJob, mode: &str) -> ManuscriptCommand {
    cmd(
        r,
        p,
        "CommitManuscriptImport",
        json!({"preparedId":j.id,"candidateHash":j.candidate_hash,"mode":mode}),
    )
}
fn add_file(r: &SqliteProjectRepository, p: &str, i: &Intake) -> String {
    let source = id();
    r.execute_manuscript(&cmd(
        r,
        p,
        "AddSourceFile",
        json!({"sourceId":source,"intakeId":i.id,"hash":i.hash}),
    ))
    .unwrap();
    source
}
#[test]
fn sources_share_history_preserve_body_and_monotonic_membership() {
    let (dir, r, p) = setup();
    let before = r.read_manuscript().unwrap();
    let source = id();
    let add = cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":source,"url":"https://example.com/evidence","title":"Only a link"}),
    );
    let receipt = r.execute_manuscript(&add).unwrap();
    assert_eq!(receipt.source_revisions.as_ref().unwrap()[0].revision, 1);
    assert!(receipt.block_revisions.is_empty());
    assert_eq!(r.read_manuscript().unwrap().blocks, before.blocks);
    assert_eq!(
        r.read_sources(None).unwrap().items[0].status,
        SourceSummaryStatus::Linkonly
    );
    assert_eq!(r.execute_manuscript(&add).unwrap(), receipt);
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    assert!(r.read_sources(None).unwrap().items.is_empty());
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    let s = r.read_sources(None).unwrap().items.remove(0).source;
    assert!(s.revision > 1);
    let remove = cmd(
        &r,
        &p,
        "RemoveSource",
        json!({"sourceId":s.id,"expectedSourceRevision":s.revision}),
    );
    r.execute_manuscript(&remove).unwrap();
    let fresh = cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":source,"url":"https://example.com","title":"Reuse forbidden"}),
    );
    assert_eq!(
        r.execute_manuscript(&fresh).unwrap_err().0,
        "INVALID_REQUEST"
    );
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(r.read_sources(None).unwrap().items.len(), 1);
    assert_eq!(r.read_history().unwrap().redo_count, 1);
    for url in [
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "javascript:alert(1)",
    ] {
        let c = cmd(
            &r,
            &p,
            "AddSourceLink",
            json!({"sourceId":id(),"url":url,"title":"invalid"}),
        );
        assert_eq!(r.execute_manuscript(&c).unwrap_err().0, "INVALID_URL");
    }
}
#[test]
fn intake_counts_actual_bytes_is_independent_and_cancel_has_no_membership() {
    let (_dir, r, p) = setup();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), b"Original project bytes").unwrap();
    let i = upload(&r, "outside.txt", &std::fs::read(outside.path()).unwrap());
    std::fs::write(outside.path(), b"External change").unwrap();
    assert_eq!(r.read_object(&i.hash).unwrap(), b"Original project bytes");
    add_file(&r, &p, &i);
    assert_eq!(r.read_sources(None).unwrap().items.len(), 1);
    let history = r.read_history().unwrap();
    let id = id();
    r.begin_intake(&id, "huge.txt", "text/plain").unwrap();
    for _ in 0..25 {
        r.append_intake(&id, &vec![0; 1024 * 1024]).unwrap();
    }
    assert_eq!(r.append_intake(&id, &[0]).unwrap_err().0, "INPUT_TOO_LARGE");
    r.cancel_intake(&id).unwrap();
    assert!(r.complete_intake(&id).is_err());
    assert_eq!(r.read_history().unwrap(), history);
    let id = super::tests::id();
    assert!(r.begin_intake(&id, "../unsafe.txt", "text/plain").is_err());
}
#[test]
fn import_start_append_replace_cancel_stale_replay_and_no_reparse_history() {
    let (dir, r, p) = setup();
    let initial = r.read_history().unwrap();
    let j = prepare(&r, "中文 🐦\n\nSecond");
    assert_eq!(j.status, DocumentJobStatus::Ready);
    assert_eq!(r.read_history().unwrap(), initial);
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    let c = commit(&r, &p, &j, "start");
    let receipt = r.execute_manuscript(&c).unwrap();
    assert_eq!(r.execute_manuscript(&c).unwrap(), receipt);
    let first = r.read_manuscript().unwrap();
    assert_eq!(first.blocks.len(), 2);
    assert!(r.read_sources(None).unwrap().items.is_empty());
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    assert_eq!(
        r.read_manuscript().unwrap().workspace_stage,
        ManuscriptStateWorkspaceStage::Outline
    );
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    assert_eq!(
        r.read_manuscript().unwrap().blocks[0].id,
        first.blocks[0].id
    );
    let j = prepare(&r, "Appended");
    r.execute_manuscript(&commit(&r, &p, &j, "append")).unwrap();
    assert_eq!(r.read_manuscript().unwrap().blocks.len(), 3);
    let cancelled = prepare(&r, "Cancelled");
    let before = r.read_manuscript().unwrap();
    let h = r.read_history().unwrap();
    r.document_action(&DocumentAction::Cancel {
        job_id: cancelled.id.clone(),
    })
    .unwrap();
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(r.read_history().unwrap(), h);
    assert_eq!(
        r.execute_manuscript(&commit(&r, &p, &cancelled, "replace"))
            .unwrap_err()
            .0,
        "IMPORT_STALE"
    );
    let stale = prepare(&r, "Old preview");
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":source,"url":"https://example.com","title":"Advance project"}),
    ))
    .unwrap();
    let c = commit(&r, &p, &stale, "replace");
    assert_eq!(r.execute_manuscript(&c).unwrap_err().0, "IMPORT_STALE");
    assert_eq!(r.execute_manuscript(&c).unwrap_err().0, "IMPORT_STALE");
    let j = prepare(&r, "Replacement");
    r.execute_manuscript(&commit(&r, &p, &j, "replace"))
        .unwrap();
    let replaced = r.read_manuscript().unwrap();
    assert_eq!(replaced.blocks.len(), 1);
    assert!(!first.blocks.iter().any(|b| b.id == replaced.blocks[0].id));
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    assert_eq!(r.read_manuscript().unwrap().blocks.len(), 3);
    let count: i64 = r
        .connection
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM document_attempts", [], |r| r.get(0))
        .unwrap();
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    assert_eq!(
        r.read_manuscript().unwrap().blocks[0].id,
        replaced.blocks[0].id
    );
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM document_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        count
    );
}
#[test]
fn extraction_completion_removal_undo_cancel_and_reopen_are_fenced() {
    let (dir, r, p) = setup();
    let i = upload(&r, "reference.md", b"# Reference\n\nNo body insertion");
    let source = add_file(&r, &p, &i);
    let id = id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: id.clone(),
        source_id: source.clone(),
    })
    .unwrap();
    let h = r.read_history().unwrap();
    r.run_document(&id).unwrap();
    assert_eq!(r.read_history().unwrap(), h);
    assert!(
        r.extraction_page(&id, 0)
            .unwrap()
            .text
            .contains("Reference")
    );
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    assert_eq!(
        r.read_sources(None).unwrap().items[0].status,
        SourceSummaryStatus::Ready
    );
    let retry = super::tests::id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: retry.clone(),
        source_id: source,
    })
    .unwrap();
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    r.finish_job(
        &retry,
        1,
        Ok(DocumentResult {
            parser: "fake/1".into(),
            text: "Late".into(),
            blocks: vec![],
            warnings: vec![],
            has_images: false,
            references: vec![],
        }),
    )
    .unwrap();
    assert!(r.read_sources(None).unwrap().items.is_empty());
    assert_ne!(
        r.document_job(&retry).unwrap().status,
        DocumentJobStatus::Ready
    );
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    assert_eq!(
        r.read_sources(None).unwrap().items[0].status,
        SourceSummaryStatus::Ready
    );
    let source = r.read_sources(None).unwrap().items[0].source.id.clone();
    let queued = super::tests::id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: queued.clone(),
        source_id: source,
    })
    .unwrap();
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        r.document_job(&queued).unwrap().status,
        DocumentJobStatus::Interrupted
    );
}
#[test]
fn real_worker_timeout_memory_and_cancellation_are_supervised() {
    let (_dir, r, _) = setup();
    let make = |r: &SqliteProjectRepository| {
        let id = id();
        r.document_action(&DocumentAction::PreparePaste {
            job_id: id.clone(),
            text: "worker".into(),
            expected_working_revision: 0,
        })
        .unwrap();
        id
    };
    let timeout = make(&r);
    r.run_document_with_limits(&timeout, Duration::ZERO, 512 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        r.document_job(&timeout).unwrap().error.as_deref(),
        Some("DOCUMENT_PARSE_TIMEOUT")
    );
    #[cfg(target_os = "linux")]
    {
        let memory = make(&r);
        r.run_document_with_limits(&memory, Duration::from_secs(60), 1)
            .unwrap();
        assert_eq!(
            r.document_job(&memory).unwrap().error.as_deref(),
            Some("DOCUMENT_RESOURCE_LIMIT")
        );
    }
    let r = Arc::new(r);
    let cancelled = make(&r);
    let runner = r.clone();
    let worker_id = cancelled.clone();
    let worker = std::thread::spawn(move || runner.run_document(&worker_id));
    for _ in 0..100 {
        if r.document_job(&cancelled).unwrap().status == DocumentJobStatus::Running {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        r.document_job(&cancelled).unwrap().status,
        DocumentJobStatus::Running
    );
    r.document_action(&DocumentAction::Cancel {
        job_id: cancelled.clone(),
    })
    .unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(
        r.document_job(&cancelled).unwrap().status,
        DocumentJobStatus::Cancelled
    );
    assert_eq!(r.document_job(&cancelled).unwrap().attempt, 2);
}
#[test]
fn empty_encoding_control_and_size_failures_never_replace_body() {
    let (_dir, r, p) = setup();
    let j = prepare(&r, "Existing");
    r.execute_manuscript(&commit(&r, &p, &j, "start")).unwrap();
    let state = r.read_manuscript().unwrap();
    let h = r.read_history().unwrap();
    for (bytes, error) in [
        (b"".as_slice(), "SOURCE_TEXT_UNAVAILABLE"),
        (&[0xff], "TEXT_ENCODING_UNSUPPORTED"),
        (b"bad\0control".as_slice(), "DOCUMENT_INVALID"),
    ] {
        let i = upload(&r, "bad.txt", bytes);
        let job = id();
        r.document_action(&DocumentAction::PrepareFile {
            job_id: job.clone(),
            intake_id: i.id,
            expected_working_revision: state.working_revision,
        })
        .unwrap();
        r.run_document(&job).unwrap();
        assert_eq!(r.document_job(&job).unwrap().error.as_deref(), Some(error));
    }
    let j = prepare(&r, &"a".repeat(1024 * 1024 + 1));
    assert_eq!(j.error.as_deref(), Some("DOCUMENT_TOO_LARGE"));
    assert_eq!(r.read_manuscript().unwrap(), state);
    assert_eq!(r.read_history().unwrap(), h);
}
#[test]
fn import_storage_fault_is_atomic_and_original_request_remains_retryable() {
    let (_dir, r, p) = setup();
    let j = prepare(&r, "Imported");
    let c = commit(&r, &p, &j, "start");
    let before = r.read_history().unwrap();
    r.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'fault'); END").unwrap();
    assert_eq!(
        r.execute_manuscript(&c).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    assert_eq!(r.read_history().unwrap(), before);
    assert_eq!(
        r.command_receipt(manuscript::envelope(&c).0).unwrap_err().0,
        "COMMAND_NOT_FOUND"
    );
    r.collect_objects(Duration::ZERO).unwrap();
    r.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_receipt")
        .unwrap();
    let receipt = r.execute_manuscript(&c).unwrap();
    assert_eq!(r.execute_manuscript(&c).unwrap(), receipt);
}
#[test]
fn injected_policy_protects_import_and_source_history_at_actual_commit_boundary() {
    struct Guard(String);
    impl manuscript::MutationPolicy for Guard {
        fn validate(
            &self,
            _: &ManuscriptState,
            _: &ManuscriptState,
            affected: &BTreeSet<String>,
        ) -> Result<()> {
            if affected.contains(&self.0) {
                Err(ManuscriptError("CONTENT_LOCKED", None))
            } else {
                Ok(())
            }
        }
    }
    let (_dir, r, p) = setup();
    let j = prepare(&r, "Protected");
    r.execute_manuscript(&commit(&r, &p, &j, "start")).unwrap();
    let before = r.read_manuscript().unwrap();
    let r = r.with_policy(Arc::new(Guard(before.blocks[0].id.clone())));
    let j = prepare(&r, "Replace");
    assert_eq!(
        r.execute_manuscript(&commit(&r, &p, &j, "replace"))
            .unwrap_err()
            .0,
        "CONTENT_LOCKED"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    let source = id();
    let (_dir, r, p) = setup();
    let r = r.with_policy(Arc::new(Guard(source.clone())));
    let c = cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":source,"url":"https://example.com","title":"Protected source"}),
    );
    assert_eq!(r.execute_manuscript(&c).unwrap_err().0, "CONTENT_LOCKED");
    assert!(r.read_sources(None).unwrap().items.is_empty());
}
#[test]
fn gc_pins_old_payload_prunes_rows_preserves_identities_and_rolls_back_before_unlink() {
    let (_dir, r, p) = setup();
    let j = prepare(&r, "Old imported payload");
    r.execute_manuscript(&commit(&r, &p, &j, "start")).unwrap();
    let (old_id, old_hash) = {
        let c = r.connection.lock().unwrap();
        c.query_row("SELECT id,payload_hash FROM blocks", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap()
    };
    let pin = id();
    r.pin_object(&pin, &old_hash).unwrap();
    for n in 0..6 {
        let j = prepare(&r, &format!("Replacement {n}"));
        r.execute_manuscript(&commit(&r, &p, &j, "replace"))
            .unwrap();
    }
    r.collect_objects(Duration::ZERO).unwrap();
    assert!(r.read_object(&old_hash).is_ok());
    r.unpin_objects(&pin).unwrap();
    r.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_prune BEFORE DELETE ON content_revisions BEGIN SELECT RAISE(ABORT,'fault'); END").unwrap();
    assert_eq!(
        r.collect_objects(Duration::ZERO).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert!(r.read_object(&old_hash).is_ok());
    r.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_prune")
        .unwrap();
    assert!(r.collect_objects(Duration::ZERO).unwrap() > 0);
    assert!(r.read_object(&old_hash).is_err());
    assert!(
        r.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT high_water FROM object_identities WHERE id=?1",
                [&old_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
            > 0
    );
    let reused = r.document_action(&DocumentAction::PreparePaste {
        job_id: j.id,
        text: "late utility identity reuse".into(),
        expected_working_revision: r.read_manuscript().unwrap().working_revision,
    });
    assert_eq!(reused.unwrap_err().0, "REQUEST_ID_CONFLICT");
    r.verify_manuscript().unwrap();
}
#[test]
fn promoted_preparation_and_gc_share_the_writer_coordinator() {
    let (_dir, r, _) = setup();
    let job = id();
    r.document_action(&DocumentAction::PreparePaste {
        job_id: job.clone(),
        text: "preparation original".into(),
        expected_working_revision: 0,
    })
    .unwrap();
    let r = Arc::new(r);
    let lock = r.connection.lock().unwrap();
    let result = DocumentResult {
        parser: "fixture/1".into(),
        text: "preparation original".into(),
        blocks: vec![NewBlock {
            id: id(),
            kind: BlockKind::Paragraph,
            attrs: BlockAttrs {
                level: None,
                list_kind: None,
                depth: None,
            },
            runs: vec![TextRun {
                text: "preparation original".into(),
                marks: vec![],
            }],
        }],
        warnings: vec![],
        references: vec![],
        has_images: false,
    };
    let digest = r.object(&serde_json::to_vec(&result).unwrap()).unwrap();
    let other = r.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let gc = std::thread::spawn(move || {
        send.send(false).unwrap();
        let result = other.collect_objects(Duration::ZERO).unwrap();
        send.send(true).unwrap();
        result
    });
    receive.recv().unwrap();
    assert!(receive.recv_timeout(Duration::from_millis(10)).is_err());
    // Promotion and the prepared-result reference commit hold this same coordinator.
    lock.execute(
        "UPDATE document_attempts SET status='ready',result_hash=?2,candidate_hash=?3 WHERE id=?1",
        params![
            job,
            digest,
            hash(&serde_json::to_vec(&result.blocks).unwrap())
        ],
    )
    .unwrap();
    drop(lock);
    assert!(receive.recv().unwrap());
    gc.join().unwrap();
    assert_eq!(r.document_job(&job).unwrap().result.unwrap(), result);
    assert!(r.read_object(&digest).is_ok());
}

#[test]
fn event_expiration_replay_and_extraction_progress_do_not_execute_business_work() {
    let (_dir, r, p) = setup();
    for n in 0..510 {
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "AddSourceLink",
            json!({"sourceId":id(),"url":"https://example.com","title":format!("Source {n}")}),
        ))
        .unwrap();
    }
    let state = r.read_manuscript().unwrap();
    let h = r.read_history().unwrap();
    assert!(r.events(1).unwrap().resync_required);
    let page = r.events(0).unwrap();
    assert!(page.resync_required);
    let latest = page.latest;
    assert!(r.events(latest).unwrap().events.is_empty());
    let replay = r.events(latest - 3).unwrap();
    assert_eq!(replay.events.len(), 3);
    assert_eq!(r.events(latest - 3).unwrap(), replay);
    assert_eq!(r.read_manuscript().unwrap(), state);
    assert_eq!(r.read_history().unwrap(), h);
}
#[test]
fn real_v3_roots_upgrade_extend_and_branch_without_rewriting_immutable_history() {
    let (dir, r, p) = setup();
    let j = prepare(&r, "Old body");
    r.execute_manuscript(&commit(&r, &p, &j, "start")).unwrap();
    let j = prepare(&r, "Second");
    r.execute_manuscript(&commit(&r, &p, &j, "append")).unwrap();
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    // Construct the exact v3 business-root shape and table set. The v1 bytes are
    // immutable inputs to migration 004, not rewritten by the upgrade.
    let mut old_objects = BTreeMap::new();
    {
        let c = r.connection.lock().unwrap();
        let mut stmt=c.prepare("SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries").unwrap();
        let hashes = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect::<Vec<_>>();
        drop(stmt);
        for old in hashes {
            let mut value: Value = serde_json::from_slice(&r.read_object(&old).unwrap()).unwrap();
            value["version"] = json!(1);
            value.as_object_mut().unwrap().remove("sources");
            let bytes = serde_json::to_vec(&value).unwrap();
            let new = r.object(&bytes).unwrap();
            c.execute(
                "UPDATE history_entries SET before_hash=?2 WHERE before_hash=?1",
                params![old, new],
            )
            .unwrap();
            c.execute(
                "UPDATE history_entries SET after_hash=?2 WHERE after_hash=?1",
                params![old, new],
            )
            .unwrap();
            c.execute(
                "UPDATE edit_groups SET before_hash=?2 WHERE before_hash=?1",
                params![old, new],
            )
            .unwrap();
            c.execute(
                "UPDATE edit_groups SET after_hash=?2 WHERE after_hash=?1",
                params![old, new],
            )
            .unwrap();
            old_objects.insert(new, bytes);
        }
        c.execute_batch("DROP TABLE sources;DROP TABLE intakes;DROP TABLE document_attempts;DROP TABLE import_provenance;DROP TABLE external_object_pins;PRAGMA user_version=3;").unwrap();
    }
    let state = r.read_manuscript().unwrap();
    let cursor = r.read_history().unwrap();
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(r.read_manuscript().unwrap(), state);
    assert_eq!(r.read_history().unwrap().cursor, cursor.cursor);
    assert_eq!(r.read_history().unwrap().redo_count, 1);
    for (digest, bytes) in &old_objects {
        assert_eq!(r.read_object(digest).unwrap(), *bytes);
    }
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"First v4 branch"}),
    ))
    .unwrap();
    assert_eq!(r.read_history().unwrap().redo_count, 0);
    let boundary_roots:i64=r.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM (SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries)",[],|r|r.get(0)).unwrap();
    assert!(boundary_roots <= 6);
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    for (digest, bytes) in &old_objects {
        assert_eq!(r.read_object(digest).unwrap(), *bytes);
    }
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    for n in 0..6 {
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "AddSourceLink",
            json!({"sourceId":id(),"url":"https://example.com","title":format!("v4 {n}")}),
        ))
        .unwrap();
    }
    let roots:i64=r.connection.lock().unwrap().query_row("SELECT COUNT(*) FROM (SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries)",[],|r|r.get(0)).unwrap();
    assert_eq!(roots, 6);
    drop(r);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
}
#[test]
fn migration004_failure_retry_keeps_verified_referenced_backup_and_old_receipts() {
    let (dir, r, p) = setup();
    let j = prepare(&r, "Acknowledged");
    let command = commit(&r, &p, &j, "start");
    let receipt = r.execute_manuscript(&command).unwrap();
    let state = r.read_manuscript().unwrap();
    drop(r);
    let c = Connection::open(dir.path().join("project.sqlite")).unwrap();
    c.execute_batch("DROP TABLE sources;DROP TABLE intakes;DROP TABLE document_attempts;DROP TABLE import_provenance;DROP TABLE external_object_pins;PRAGMA user_version=3;CREATE TABLE sources(conflict INTEGER);").unwrap();
    let prior_backups = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<BTreeSet<_>>();
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    let backups = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            !prior_backups.contains(p)
                && p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pre-migration-004-")
        })
        .collect::<Vec<_>>();
    let backup = backups.last().unwrap();
    let bytes = std::fs::read(backup.join("project.sqlite")).unwrap();
    let digest: String = c
        .query_row("SELECT snapshot_hash FROM manuscripts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        std::fs::read(backup.join("objects").join(&digest)).unwrap(),
        std::fs::read(dir.path().join("objects").join(&digest)).unwrap()
    );
    c.execute_batch("DROP TABLE sources").unwrap();
    drop(c);
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(r.read_manuscript().unwrap(), state);
    assert_eq!(r.execute_manuscript(&command).unwrap(), receipt);
    r.collect_objects(Duration::ZERO).unwrap();
    assert_eq!(std::fs::read(backup.join("project.sqlite")).unwrap(), bytes);
    assert!(backup.join("objects").join(digest).exists());
}
#[test]
fn recovery_rejects_missing_retained_source_or_prepared_input_and_cleans_abandoned_staging() {
    let (dir, r, p) = setup();
    let i = upload(&r, "source.txt", b"retained source");
    let source = add_file(&r, &p, &i);
    let bytes = r.read_object(&i.hash).unwrap();
    r.execute_manuscript(&history(&r, &p, "UndoProject"))
        .unwrap();
    assert!(r.read_sources(None).unwrap().items.is_empty());
    drop(r);
    std::fs::remove_file(dir.path().join("objects").join(&i.hash)).unwrap();
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    std::fs::write(dir.path().join("objects").join(&i.hash), bytes).unwrap();
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    r.execute_manuscript(&history(&r, &p, "RedoProject"))
        .unwrap();
    assert_eq!(r.read_sources(None).unwrap().items[0].source.id, source);
    let job = id();
    r.document_action(&DocumentAction::PreparePaste {
        job_id: job.clone(),
        text: "prepared input".into(),
        expected_working_revision: r.read_manuscript().unwrap().working_revision,
    })
    .unwrap();
    let digest = r.document_job(&job).unwrap().input_hash;
    let bytes = r.read_object(&digest).unwrap();
    let intake = id();
    r.begin_intake(&intake, "abandoned.txt", "text/plain")
        .unwrap();
    r.append_intake(&intake, b"partial").unwrap();
    drop(r);
    std::fs::remove_file(dir.path().join("objects").join(&digest)).unwrap();
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    std::fs::write(dir.path().join("objects").join(&digest), bytes).unwrap();
    let r = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(
        r.document_job(&job).unwrap().status,
        DocumentJobStatus::Interrupted
    );
    assert!(
        !dir.path()
            .join("staging")
            .join(format!("intake-{intake}"))
            .exists()
    );
}
