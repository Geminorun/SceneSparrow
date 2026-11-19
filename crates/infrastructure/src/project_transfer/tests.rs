use super::*;
use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
use serde_json::{Value, json};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn fixture() -> (tempfile::TempDir, PathBuf, SqliteProjectRepository) {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("legacy");
    let r = SqliteProjectRepository::open(&path).unwrap();
    r.create("create", "Legacy migration 🐦").unwrap();
    (d, path, r)
}
fn command(r: &SqliteProjectRepository, kind: &str, payload: Value) -> ManuscriptCommand {
    let p = r.read().unwrap().unwrap();
    let mut v = json!({"type":kind,"requestId":id(),"projectId":p.id,"expectedWorkingRevision":p.working_revision,"payload":payload});
    if kind == "UndoProject" || kind == "RedoProject" {
        let h = r.read_history().unwrap();
        v["expectedHistoryRevision"] = h.history_revision.into();
        v["expectedCursor"] = h.cursor.into();
    }
    serde_json::from_value(v).unwrap()
}
fn edit(r: &SqliteProjectRepository, operations: Value) -> ManuscriptCommand {
    let state = r.read_manuscript().unwrap();
    command(
        r,
        "ApplyDocumentEdit",
        json!({"operations":operations,"expectedBlockRevisions":state.blocks.iter().map(|b|json!({"id":b.id,"revision":b.revision})).collect::<Vec<_>>(),"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    )
}
fn block(id: &str, text: &str) -> Value {
    json!({"id":id,"kind":"paragraph","attrs":{},"runs":[{"text":text,"marks":[]}]})
}
fn request(r: &SqliteProjectRepository) -> LegacyMigrationRequest {
    let i = r.inspect_legacy_migration().unwrap();
    LegacyMigrationRequest {
        request_id: id(),
        project_id: i.project_id,
        content_base: i.content_base,
        target_id: id(),
    }
}
pub(crate) fn convert(d: &Path, source: &Path, r: &SqliteProjectRepository) -> PathBuf {
    let req = request(r);
    let target = d.join("native");
    migrate_legacy(
        MigrationPaths {
            source,
            backup: &d.join("backup"),
            staging: &d.join("stage"),
            target: &target,
            target_id: &req.target_id,
        },
        &req,
        |_, _| Ok(()),
        || false,
    )
    .unwrap();
    target
}
fn saved(r: &SqliteProjectRepository, sql: &str) -> Vec<Vec<Value>> {
    let c = r.connection.lock().unwrap();
    let mut q = c.prepare(sql).unwrap();
    let columns = q.column_count();
    q.query_map([], |row| {
        (0..columns)
            .map(|i| {
                row.get_ref(i).map(|v| match v {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => json!(n),
                    rusqlite::types::ValueRef::Text(t) => json!(std::str::from_utf8(t).unwrap()),
                    _ => panic!("fixture type"),
                })
            })
            .collect::<std::result::Result<Vec<_>, _>>()
    })
    .unwrap()
    .collect::<std::result::Result<_, _>>()
    .unwrap()
}
#[test]
fn unopened_inspection_includes_live_wal_without_source_lock_and_rejects_wrong_level() {
    let (d, path, r) = fixture();
    drop(r);
    std::fs::remove_file(path.join(".core.lock")).unwrap();
    let producer = crate::Connection::open(path.join("project.sqlite")).unwrap();
    producer.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;UPDATE project SET title='Committed WAL bird'").unwrap();
    let db_before = std::fs::read(path.join("project.sqlite")).unwrap();
    let wal_before = std::fs::read(path.join("project.sqlite-wal")).unwrap();
    let inspected = inspect_legacy(&path).unwrap();
    assert!(inspected.supported);
    assert!(!path.join(".core.lock").exists());
    let req = LegacyMigrationRequest {
        request_id: id(),
        project_id: inspected.project_id,
        content_base: inspected.content_base,
        target_id: id(),
    };
    let target = d.path().join("target");
    migrate_legacy(
        MigrationPaths {
            source: &path,
            backup: &d.path().join("backup"),
            staging: &d.path().join("stage"),
            target: &target,
            target_id: &req.target_id,
        },
        &req,
        |_, _| Ok(()),
        || false,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(path.join("project.sqlite")).unwrap(),
        db_before
    );
    assert_eq!(
        std::fs::read(path.join("project.sqlite-wal")).unwrap(),
        wal_before
    );
    assert!(!path.join(".core.lock").exists());
    let reopened = SqliteProjectRepository::open(&target).unwrap();
    assert_eq!(
        reopened.read().unwrap().unwrap().title,
        "Committed WAL bird"
    );
    assert!(inspect_legacy(&target.join(".scenesparrow")).is_err());
    assert!(inspect_legacy(&target).is_err());
}
#[test]
fn every_supported_schema_converts_in_distinct_target_without_upgrading_source() {
    for version in 1..=15 {
        let (d, path, r) = fixture();
        if version == 1 {
            let c = r.connection.lock().unwrap();
            c.pragma_update(None, "foreign_keys", false).unwrap();
            let tables = {
                let mut q=c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('project','sqlite_sequence')").unwrap();
                q.query_map([], |r| r.get::<_, String>(0))
                    .unwrap()
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .unwrap()
            };
            for t in tables {
                c.execute_batch(&format!("DROP TABLE {t}")).unwrap();
            }
            c.pragma_update(None, "user_version", 1).unwrap();
        } else {
            crate::backup::tests::downgrade(&r, version);
        }
        drop(r);
        std::fs::remove_file(path.join(".core.lock")).unwrap();
        let c = crate::Connection::open_with_flags(
            path.join("project.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let source = SqliteProjectRepository::detached(&path, c);
        let before = std::fs::read(path.join("project.sqlite")).unwrap();
        let target = convert(d.path(), &path, &source);
        assert_eq!(
            std::fs::read(path.join("project.sqlite")).unwrap(),
            before,
            "schema {version}"
        );
        assert!(!path.join(".core.lock").exists());
        let native = SqliteProjectRepository::open(&target)
            .unwrap_or_else(|e| panic!("schema {version}: {e:?}"));
        assert_eq!(
            native.read().unwrap().unwrap().id,
            source.read().unwrap().unwrap().id
        );
        let backup = native.verified_backup().unwrap();
        SqliteProjectRepository::inspect_project(&backup).unwrap();
    }
}
#[test]
fn five_actual_transitions_receipts_tokens_cursor_and_original_objects_survive_conversion() {
    let (d, path, r) = fixture();
    let bid = id();
    let first = edit(
        &r,
        json!([{"op":"insertBlock","block":block(&bid,"first 中文"),"after":null}]),
    );
    let first_receipt = r.execute_manuscript(&first).unwrap();
    for text in ["second", "third", "fourth", "fifth"] {
        r.execute_manuscript(&edit(
            &r,
            json!([{"op":"setBlockContent","id":bid,"runs":[{"text":text,"marks":[]}]}]),
        ))
        .unwrap();
    }
    let rejected = command(&r, "StartManualDraft", json!({}));
    let error = r.execute_manuscript(&rejected).unwrap_err().0;
    let tables = [
        "SELECT * FROM object_identities ORDER BY id",
        "SELECT * FROM history_entry_identities ORDER BY position",
        "SELECT * FROM history_cursor",
        "SELECT * FROM command_receipts ORDER BY request_id",
    ];
    let before: Vec<_> = tables.iter().map(|q| saved(&r, q)).collect();
    let state = r.read_manuscript().unwrap();
    let source_objects = r.retained_object_roots().unwrap();
    let target = convert(d.path(), &path, &r);
    let mut native = SqliteProjectRepository::open(&target).unwrap();
    assert_eq!(native.read_manuscript().unwrap(), state);
    for (sql, expected) in tables.iter().zip(before) {
        assert_eq!(saved(&native, sql), expected, "{sql}");
    }
    assert_eq!(native.execute_manuscript(&first).unwrap(), first_receipt);
    assert_eq!(native.execute_manuscript(&rejected).unwrap_err().0, error);
    for kind in ["UndoProject", "RedoProject"] {
        for _ in 0..5 {
            native
                .execute_manuscript(&command(&native, kind, json!({})))
                .unwrap();
            drop(native);
            native = SqliteProjectRepository::open(&target).unwrap();
        }
    }
    assert_eq!(
        native.read_manuscript().unwrap().blocks[0].runs,
        state.blocks[0].runs
    );
    native.collect_objects(std::time::Duration::ZERO).unwrap();
    for h in source_objects {
        assert!(target.join(".scenesparrow/objects").join(h).is_file());
    }
    native.verified_backup().unwrap();
}
#[test]
fn current_and_different_historical_approval_raw_evidence_preserves_ids_sequences_and_locks() {
    let (d, path, r) = fixture();
    let bid = id();
    r.execute_manuscript(&edit(
        &r,
        json!([{"op":"insertBlock","block":block(&bid,"old approved"),"after":null}]),
    ))
    .unwrap();
    for (lock, text) in [
        (true, None),
        (false, None),
        (false, Some("new approved")),
        (true, None),
    ] {
        if let Some(text) = text {
            r.execute_manuscript(&edit(
                &r,
                json!([{"op":"setBlockContent","id":bid,"runs":[{"text":text,"marks":[]}]}]),
            ))
            .unwrap();
        } else {
            r.execute_manuscript(&command(
                &r,
                "SetUserLocks",
                json!({"blockIds":if lock{vec![]}else{vec![bid.clone()]},"locked":lock,"all":lock}),
            ))
            .unwrap();
        }
    }
    let baselines = saved(
        &r,
        "SELECT sequence,id FROM approved_manifests ORDER BY sequence",
    );
    assert_eq!(baselines.len(), 2);
    let lock = saved(&r, "SELECT * FROM user_locks");
    let target = convert(d.path(), &path, &r);
    let native = SqliteProjectRepository::open(&target).unwrap();
    assert_eq!(
        saved(
            &native,
            "SELECT sequence,id FROM approved_manifests ORDER BY sequence"
        ),
        baselines
    );
    assert_eq!(saved(&native, "SELECT * FROM user_locks"), lock);
    let rows = saved(
        &native,
        "SELECT manifest_hash FROM approved_manifests ORDER BY sequence",
    );
    let raw: Vec<_> = rows
        .iter()
        .map(|row| {
            let bytes = native.read_object(row[0].as_str().unwrap()).unwrap();
            let m: crate::finalization::ApprovedManifest = serde_json::from_slice(&bytes).unwrap();
            String::from_utf8(native.read_object(&m.source_hash.unwrap()).unwrap()).unwrap()
        })
        .collect();
    assert!(raw[0].contains("old approved"));
    assert!(raw[1].contains("new approved"));
    for kind in ["UndoProject", "RedoProject"] {
        for _ in 0..5 {
            native
                .execute_manuscript(&command(&native, kind, json!({})))
                .unwrap();
        }
    }
    native.verified_backup().unwrap();
}
#[test]
fn serializer_proves_multiline_unicode_marks_empty_nested_lists_and_refuses_loss() {
    let blocks:Vec<NewBlock>=serde_json::from_value(json!([
        {"id":id(),"kind":"paragraph","attrs":{},"runs":[]},
        {"id":id(),"kind":"paragraph","attrs":{},"runs":[{"text":"hello\n世界 🐦","marks":[{"type":"bold"}]}]},
        {"id":id(),"kind":"list_item","attrs":{"depth":0,"listKind":"bullet"},"runs":[]},
        {"id":id(),"kind":"list_item","attrs":{"depth":1,"listKind":"ordered"},"runs":[{"text":"child","marks":[]}]}])).unwrap();
    let source = conversion::serialize_for_test(&blocks).unwrap();
    assert!(source.contains("scenesparrow:empty"));
    for text in ["trailing\n", " edge "] {
        let mut bad = blocks[1].clone();
        bad.runs[0].text = text.into();
        assert_eq!(
            conversion::serialize_for_test(&[bad]).unwrap_err().0,
            "MIGRATION_UNSUPPORTED"
        );
    }
}
#[test]
fn journal_original_outcome_replays_before_newer_base_and_reused_payload_conflicts() {
    let (d, _path, r) = fixture();
    let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    let target_request = MigrationTargetRequest {
        request_id: id(),
        project_id: r.read().unwrap().unwrap().id,
        destination: MigrationTargetRequestDestination::Managed,
    };
    let target = store.issue_target(&r, &target_request).unwrap();
    assert_eq!(target, store.issue_target(&r, &target_request).unwrap());
    let mut req = request(&r);
    req.target_id = target.target_id;
    let original = store.start(&r, &req).unwrap();
    r.execute_manuscript(&edit(
        &r,
        json!([{"op":"insertBlock","block":block(&id(),"later"),"after":null}]),
    ))
    .unwrap();
    assert_eq!(store.start(&r, &req).unwrap(), original);
    let mut changed = req.clone();
    changed.content_base = "a".repeat(64);
    assert_eq!(
        store.start(&r, &changed).unwrap_err().0,
        "MIGRATION_REQUEST_CONFLICT"
    );
    store.run_next(&r).unwrap();
    assert_eq!(
        store
            .status(&r, &req.request_id)
            .unwrap()
            .failure_code
            .as_deref(),
        Some("MIGRATION_BASE_MISMATCH")
    );
    let view = store.status(&r, &req.request_id).unwrap();
    let control = MigrationControlRequest {
        request_id: id(),
        project_id: req.project_id,
        operation_id: req.request_id.clone(),
        expected_operation_revision: view.operation_revision,
        action: MigrationControlRequestAction::Retry,
    };
    assert_eq!(
        store.control(&r, &req.request_id, &control).unwrap_err().0,
        "MIGRATION_BASE_MISMATCH"
    );
    assert_eq!(
        store.control(&r, &req.request_id, &control).unwrap_err().0,
        "MIGRATION_BASE_MISMATCH"
    );
}
#[test]
fn interrupted_queue_requires_explicit_retry_and_ready_reconciles_after_promotion() {
    let (d, _path, r) = fixture();
    let app = d.path().join("app");
    let store = ProjectTransferStore::open(&app).unwrap();
    let target = store
        .issue_target(
            &r,
            &MigrationTargetRequest {
                request_id: id(),
                project_id: r.read().unwrap().unwrap().id,
                destination: MigrationTargetRequestDestination::Managed,
            },
        )
        .unwrap();
    let mut req = request(&r);
    req.target_id = target.target_id;
    store.start(&r, &req).unwrap();
    drop(store);
    let store = ProjectTransferStore::open(&app).unwrap();
    let view = store.status(&r, &req.request_id).unwrap();
    assert_eq!(view.state, MigrationOperationViewState::Interrupted);
    assert!(!store.run_next(&r).unwrap());
    let c = MigrationControlRequest {
        request_id: id(),
        project_id: req.project_id.clone(),
        operation_id: req.request_id.clone(),
        expected_operation_revision: view.operation_revision,
        action: MigrationControlRequestAction::Retry,
    };
    store.control(&r, &req.request_id, &c).unwrap();
    assert!(store.run_next(&r).unwrap());
    let ready = store.status(&r, &req.request_id).unwrap();
    assert_eq!(ready.state, MigrationOperationViewState::Succeeded);
    // Reconstruct the precise crash window: durable target, old running journal.
    let p = app
        .join("project-transfers")
        .join(format!("operation-{}.json", req.request_id));
    let mut v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["view"]["state"] = json!("running");
    v["view"]["phase"] = json!("promote");
    v["view"].as_object_mut().unwrap().remove("resultId");
    std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
    assert_eq!(
        store.status(&r, &req.request_id).unwrap().result_id,
        ready.result_id
    );
    assert_eq!(
        store.start(&r, &req).unwrap().operation.state,
        MigrationOperationViewState::Queued
    );
}
#[test]
fn native_fault_cuts_keep_source_backup_and_never_clobber_target() {
    for cut in [
        MigrationOperationViewPhase::Upgrade,
        MigrationOperationViewPhase::Serialize,
        MigrationOperationViewPhase::Verify,
        MigrationOperationViewPhase::Promote,
        MigrationOperationViewPhase::Ready,
    ] {
        let (d, path, r) = fixture();
        let req = request(&r);
        let before = saved(&r, "SELECT * FROM project");
        let target = d.path().join("target");
        let result = migrate_legacy(
            MigrationPaths {
                source: &path,
                backup: &d.path().join("backup"),
                staging: &d.path().join("stage"),
                target: &target,
                target_id: &req.target_id,
            },
            &req,
            |phase, _| {
                if phase == cut {
                    Err(fail("TEST_CUT"))
                } else {
                    Ok(())
                }
            },
            || false,
        );
        assert!(result.is_err());
        assert_eq!(saved(&r, "SELECT * FROM project"), before);
        SqliteProjectRepository::inspect_project(&d.path().join("backup")).unwrap();
        assert!(d.path().join("backup/manifest.json").is_file());
        assert_eq!(target.exists(), cut == MigrationOperationViewPhase::Ready);
    }
    let (d, path, r) = fixture();
    let req = request(&r);
    let target = d.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("sentinel"), "keep").unwrap();
    assert!(
        migrate_legacy(
            MigrationPaths {
                source: &path,
                backup: &d.path().join("backup"),
                staging: &d.path().join("stage"),
                target: &target,
                target_id: &req.target_id
            },
            &req,
            |_, _| Ok(()),
            || false
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(target.join("sentinel")).unwrap(),
        "keep"
    );
}
pub(crate) fn mock_provider(
    settings: &crate::ai::settings::SettingsStore,
    output: Value,
) -> (
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::thread::JoinHandle<()>,
) {
    use scenesparrow_application::ai::AiSettingsPort;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut view = settings.read_settings().unwrap();
    view.settings.providers[0].base_url =
        format!("http://{}/custom", listener.local_addr().unwrap());
    settings
        .update_settings(&AiSettingsUpdate {
            expected_revision: view.settings.revision,
            settings: view.settings,
        })
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let counted = count.clone();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut request = vec![];
        let mut buffer = [0u8; 8192];
        loop {
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0);
            request.extend_from_slice(&buffer[..n]);
            if let Some(at) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                let size = std::str::from_utf8(&request[..at])
                    .unwrap()
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
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
        let body=json!({"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":output.to_string()}}]}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    });
    (count, server)
}
#[test]
fn unsafe_native_backup_aliases_are_refused_before_source_writes() {
    let (d, path, r) = fixture();
    let req = request(&r);
    for backup in [
        path.join("backup"),
        path.clone(),
        d.path().join("stage"),
        d.path().join("target"),
    ] {
        let before = std::fs::read(path.join("project.sqlite")).unwrap();
        let result = migrate_legacy(
            MigrationPaths {
                source: &path,
                backup: &backup,
                staging: &d.path().join("stage"),
                target: &d.path().join("target"),
                target_id: &req.target_id,
            },
            &req,
            |_, _| Ok(()),
            || false,
        );
        assert_eq!(result.unwrap_err().0, "MIGRATION_TARGET_INVALID");
        assert_eq!(std::fs::read(path.join("project.sqlite")).unwrap(), before);
        assert!(!path.join("backup").exists());
    }
}
#[test]
fn missing_closure_and_unsupported_source_preserve_verified_backup_and_source() {
    let (d, path, r) = fixture();
    let bid = id();
    r.execute_manuscript(&edit(
        &r,
        json!([{"op":"insertBlock","block":block(&bid,"trailing\n"),"after":null}]),
    ))
    .unwrap();
    let req = request(&r);
    let original = r.read_manuscript().unwrap();
    let result = migrate_legacy(
        MigrationPaths {
            source: &path,
            backup: &d.path().join("backup"),
            staging: &d.path().join("stage"),
            target: &d.path().join("target"),
            target_id: &req.target_id,
        },
        &req,
        |_, _| Ok(()),
        || false,
    );
    assert_eq!(result.unwrap_err().0, "MIGRATION_UNSUPPORTED");
    assert_eq!(r.read_manuscript().unwrap(), original);
    assert!(d.path().join("backup/manifest.json").is_file());
    assert!(!d.path().join("target").exists());
    let root = r
        .retained_object_roots()
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    std::fs::remove_file(path.join("objects").join(root)).unwrap();
    assert!(inspect_legacy(&path).is_err());
}
#[test]
fn escaped_worker_envelope_and_actual_source_have_independent_limits() {
    let b: NewBlock =
        serde_json::from_value(block(&id(), &"\\".repeat(2 * 1024 * 1024 + 1))).unwrap();
    assert_eq!(
        conversion::serialize_for_test(&[b]).unwrap_err().0,
        "MIGRATION_SIZE_LIMIT"
    );
}
#[test]
fn backup_inventory_keeps_materialized_wal_generation_while_live_source_advances() {
    let (d, path, r) = fixture();
    let bid = id();
    r.execute_manuscript(&edit(
        &r,
        json!([{"op":"insertBlock","block":block(&bid,"captured old"),"after":null}]),
    ))
    .unwrap();
    let c = crate::Connection::open_with_flags(
        path.join("project.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    c.execute_batch("BEGIN").unwrap();
    let old_revision: i64 = c
        .query_row("SELECT working_revision FROM project", [], |r| r.get(0))
        .unwrap();
    // This later committed WAL generation must never be mixed into old inventory.
    r.execute_manuscript(&edit(
        &r,
        json!([{"op":"setBlockContent","id":bid,"runs":[{"text":"new live","marks":[]}]}]),
    ))
    .unwrap();
    let target = d.path().join("snapshot");
    crate::backup::snapshot(&c, &path, &target, None).unwrap();
    let captured = SqliteProjectRepository::open(&target).unwrap();
    assert_eq!(
        captured.read().unwrap().unwrap().working_revision,
        old_revision
    );
    assert_eq!(
        captured.read_manuscript().unwrap().blocks[0].runs[0].text,
        "captured old"
    );
    assert_eq!(
        r.read_manuscript().unwrap().blocks[0].runs[0].text,
        "new live"
    );
}
#[test]
fn five_queue_limit_failure_receipts_and_same_uuid_other_root_are_scoped() {
    let (d, path, r) = fixture();
    let store = ProjectTransferStore::open(&d.path().join("app")).unwrap();
    let mut requests = vec![];
    for _ in 0..6 {
        let target = store
            .issue_target(
                &r,
                &MigrationTargetRequest {
                    request_id: id(),
                    project_id: r.read().unwrap().unwrap().id,
                    destination: MigrationTargetRequestDestination::Managed,
                },
            )
            .unwrap();
        let mut req = request(&r);
        req.target_id = target.target_id;
        requests.push(req);
    }
    for req in &requests[..5] {
        store.start(&r, req).unwrap();
    }
    assert_eq!(
        store.start(&r, &requests[5]).unwrap_err().0,
        "MIGRATION_QUEUE_FULL"
    );
    let view = store.status(&r, &requests[0].request_id).unwrap();
    store
        .control(
            &r,
            &requests[0].request_id,
            &MigrationControlRequest {
                request_id: id(),
                project_id: requests[0].project_id.clone(),
                operation_id: requests[0].request_id.clone(),
                expected_operation_revision: view.operation_revision,
                action: MigrationControlRequestAction::Cancel,
            },
        )
        .unwrap();
    assert_eq!(
        store.start(&r, &requests[5]).unwrap_err().0,
        "MIGRATION_QUEUE_FULL"
    );
    let backup = r.verified_backup().unwrap();
    let other =
        SqliteProjectRepository::restore_verified_copy(&backup, &d.path().join("other")).unwrap();
    assert_eq!(
        other.read().unwrap().unwrap().id,
        r.read().unwrap().unwrap().id
    );
    assert_eq!(
        store.status(&other, &requests[1].request_id).unwrap_err().0,
        "MIGRATION_NOT_FOUND"
    );
    assert!(!store.run_next(&other).unwrap());
    assert!(path.join("project.sqlite").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn migration_binds_backup_and_target_aliases_before_phase_callbacks() {
    use std::os::unix::fs::symlink;
    for swap_backup in [false, true] {
        let (d, source, repository) = fixture();
        let safe = d.path().join("safe");
        let alias = d.path().join("alias");
        std::fs::create_dir(&safe).unwrap();
        symlink(&safe, &alias).unwrap();
        let request = request(&repository);
        let backup = if swap_backup {
            alias.join("backup")
        } else {
            safe.join("backup")
        };
        let stage = safe.join("stage");
        let target = if swap_backup {
            safe.join("target")
        } else {
            alias.join("target")
        };
        let original = saved(&repository, "SELECT * FROM project");
        let mut swapped = false;
        let result = migrate_legacy(
            MigrationPaths {
                source: &source,
                backup: &backup,
                staging: &stage,
                target: &target,
                target_id: &request.target_id,
            },
            &request,
            |phase, _| {
                if !swapped
                    && phase
                        == if swap_backup {
                            MigrationOperationViewPhase::Backup
                        } else {
                            MigrationOperationViewPhase::Promote
                        }
                {
                    std::fs::remove_file(&alias).unwrap();
                    symlink(&source, &alias).unwrap();
                    swapped = true;
                }
                Ok(())
            },
            || false,
        );
        assert!(swapped);
        assert!(
            !source.join("backup").exists(),
            "a changed backup alias wrote into the source"
        );
        assert!(
            !source.join("target").exists(),
            "a changed target alias promoted into the source"
        );
        assert_eq!(saved(&repository, "SELECT * FROM project"), original);
        if result.is_ok() {
            assert!(safe.join("backup/manifest.json").is_file());
            SqliteProjectRepository::open(&safe.join("target")).unwrap();
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn migration_refuses_replaced_canonical_parent_without_touching_source_or_unknown_target() {
    use std::os::unix::fs::symlink;
    for cut in [
        MigrationOperationViewPhase::Backup,
        MigrationOperationViewPhase::Promote,
    ] {
        let (d, source, repository) = fixture();
        let safe = d.path().join("safe");
        let displaced = d.path().join("displaced-parent");
        std::fs::create_dir(&safe).unwrap();
        std::fs::create_dir(source.join("target")).unwrap();
        std::fs::write(source.join("target/sentinel"), "unknown target remains").unwrap();
        let request = request(&repository);
        let original = saved(&repository, "SELECT * FROM project");
        let mut swapped = false;
        let result = migrate_legacy(
            MigrationPaths {
                source: &source,
                backup: &safe.join("backup"),
                staging: &safe.join("stage"),
                target: &safe.join("target"),
                target_id: &request.target_id,
            },
            &request,
            |phase, _| {
                if !swapped && phase == cut {
                    std::fs::rename(&safe, &displaced).unwrap();
                    symlink(&source, &safe).unwrap();
                    swapped = true;
                }
                Ok(())
            },
            || false,
        );
        assert!(swapped);
        assert!(result.is_err());
        assert!(
            !source.join("backup").exists(),
            "replacement parent redirected backup into source"
        );
        assert!(!source.join("stage").exists());
        assert_eq!(
            std::fs::read_to_string(source.join("target/sentinel")).unwrap(),
            "unknown target remains"
        );
        assert_eq!(saved(&repository, "SELECT * FROM project"), original);
        if cut == MigrationOperationViewPhase::Promote {
            assert!(displaced.join("backup/manifest.json").is_file());
            assert!(
                displaced
                    .join("stage/.scenesparrow/migration-ready.json")
                    .is_file()
            );
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
fn migration_target_alias_swap_preserves_late_bound_and_source_unknown_targets() {
    use std::os::unix::fs::symlink;
    let (d, source, repository) = fixture();
    let safe = d.path().join("safe");
    let alias = d.path().join("alias");
    std::fs::create_dir(&safe).unwrap();
    symlink(&safe, &alias).unwrap();
    std::fs::create_dir(source.join("target")).unwrap();
    std::fs::write(source.join("target/sentinel"), "source unknown").unwrap();
    let request = request(&repository);
    let mut swapped = false;
    let result = migrate_legacy(
        MigrationPaths {
            source: &source,
            backup: &safe.join("backup"),
            staging: &safe.join("stage"),
            target: &alias.join("target"),
            target_id: &request.target_id,
        },
        &request,
        |phase, _| {
            if phase == MigrationOperationViewPhase::Promote {
                std::fs::remove_file(&alias).unwrap();
                symlink(&source, &alias).unwrap();
                std::fs::create_dir(safe.join("target")).unwrap();
                std::fs::write(safe.join("target/sentinel"), "bound unknown").unwrap();
                swapped = true;
            }
            Ok(())
        },
        || false,
    );
    assert!(swapped);
    assert_eq!(result.unwrap_err().0, "MIGRATION_TARGET_EXISTS");
    assert_eq!(
        std::fs::read_to_string(source.join("target/sentinel")).unwrap(),
        "source unknown"
    );
    assert_eq!(
        std::fs::read_to_string(safe.join("target/sentinel")).unwrap(),
        "bound unknown"
    );
    assert!(safe.join("backup/manifest.json").is_file());
    assert!(
        safe.join("stage/.scenesparrow/migration-ready.json")
            .is_file()
    );
    assert!(!source.join("backup").exists());
    assert!(!source.join("stage").exists());
}
