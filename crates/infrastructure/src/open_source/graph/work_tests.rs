use super::super::tests::{command, id, request};
use super::tests::{put, seed};
use super::*;
use scenesparrow_application::manuscript::{DocumentRepository, ManuscriptRepository};
use std::{sync::mpsc, time::Duration};
fn whole() -> CreativeGrant {
    CreativeGrant {
        whole_tree: true,
        files: vec![],
        directories: vec![],
        manuscript_scope: CreativeGrantManuscriptScope {
            kind: CreativeGrantManuscriptScopeKind::All,
            block_ids: vec![],
        },
    }
}
fn create(
    repo: &SqliteProjectRepository,
    grant: CreativeGrant,
    live: bool,
) -> WorkItemCreateRequest {
    let g = repo.accepted_file_graph().unwrap().unwrap();
    WorkItemCreateRequest {
        request_id: id(),
        project_id: g.graph.project_id,
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: g.hash,
        expected_graph_generation: g.generation,
        origin: if live {
            WorkItemCreateRequestOrigin::Live
        } else {
            WorkItemCreateRequestOrigin::Copy
        },
        grant,
        reference_ids: vec![],
    }
}
fn ready(repo: &SqliteProjectRepository, grant: CreativeGrant, live: bool) -> WorkItemView {
    let r = create(repo, grant, live);
    let item = repo.create_work_item(&r).unwrap().item.unwrap();
    repo.run_next_work_operation().unwrap();
    repo.work_item(&item.work_item_id).unwrap()
}
fn inspect(repo: &SqliteProjectRepository, item: &WorkItemView) -> WorkItemView {
    let g = repo.accepted_file_graph().unwrap().unwrap();
    let r = WorkItemInspectRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: g.hash,
        expected_graph_generation: g.generation,
        work_item_id: item.work_item_id.clone(),
        expected_item_revision: item.item_revision,
    };
    repo.inspect_work_item(&r).unwrap();
    repo.run_next_work_operation().unwrap();
    repo.work_item(&item.work_item_id).unwrap()
}
fn accept(item: &WorkItemView) -> WorkCandidateAcceptRequest {
    let candidate = item.latest_candidate.as_ref().unwrap();
    WorkCandidateAcceptRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: candidate.inspected_working_revision,
        expected_graph_hash: item.base_graph_hash.clone(),
        expected_graph_generation: candidate.inspected_graph_generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: candidate.candidate_id.clone(),
        candidate_digest: candidate.candidate_digest.clone(),
        expected_item_revision: item.item_revision,
    }
}
fn locks(repo: &SqliteProjectRepository, path: &str, locked: bool) -> ProductionFileLockRequest {
    let g = repo.accepted_file_graph().unwrap().unwrap();
    let member = g.graph.file(path).unwrap();
    ProductionFileLockRequest {
        request_id: id(),
        project_id: g.graph.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: g.hash,
        expected_graph_generation: g.generation,
        locked,
        targets: vec![ProductionFileLockTarget {
            path: path.into(),
            hash: member.hash.clone(),
        }],
    }
}
#[test]
fn recorded_copy_scope_preparation_receipt_and_history() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "A\n\nB\n")).unwrap();
    let r = create(&repo, whole(), false);
    let start = repo.create_work_item(&r).unwrap();
    assert_eq!(repo.create_work_item(&r).unwrap(), start);
    let mut collision = r.clone();
    collision.grant = CreativeGrant {
        whole_tree: false,
        ..whole()
    };
    assert_eq!(
        repo.create_work_item(&collision).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    repo.run_next_work_operation().unwrap();
    let item = repo.work_item(&start.item.unwrap().work_item_id).unwrap();
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    assert!(!copy.join(".scenesparrow").exists());
    put(&copy, "public/clip.bin", b"changed binary\0\xff");
    let raw = std::fs::read_to_string(copy.join("manuscript.md")).unwrap() + "\nNew paragraph\n";
    put(&copy, "manuscript.md", raw.as_bytes());
    let inspected = inspect(&repo, &item);
    let view = inspected.latest_candidate.clone().unwrap();
    assert_eq!(view.assigned_ids, 1);
    assert_ne!(view.original_graph_hash, view.prepared_graph_hash);
    let again = inspect(&repo, &inspected);
    let rebound = again.latest_candidate.as_ref().unwrap();
    assert_eq!(rebound.prepared_graph_hash, view.prepared_graph_hash);
    assert_eq!(rebound.original_graph_hash, view.original_graph_hash);
    let before = repo.read_history().unwrap();
    let a = accept(&again);
    let result = repo.accept_work_candidate(&a).unwrap();
    assert_eq!(result.receipt.undo_count, (before.undo_count + 1).min(5));
    assert_eq!(
        repo.work_item(&item.work_item_id).unwrap().state,
        WorkItemViewState::Accepted
    );
    let original = result.receipt.clone();
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_ne!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"changed binary\0\xff"
    );
    command(&repo, "RedoProject", serde_json::json!({}));
    // Even after candidate pruning and later graph/history transitions, receipt
    // lookup precedes payload authorization and binds the entire external DTO.
    {
        let c = repo.connection.lock().unwrap();
        c.execute("DELETE FROM work_candidates", []).unwrap();
        c.execute("UPDATE work_items SET latest_candidate=NULL", [])
            .unwrap();
    }
    assert_eq!(repo.accept_work_candidate(&a).unwrap().receipt, original);
    let mut changed = a.clone();
    changed.work_item_id = id();
    assert_eq!(
        repo.accept_work_candidate(&changed).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    repo.collect_objects(Duration::ZERO).unwrap();
    drop(repo);
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(
        reopened.accept_work_candidate(&a).unwrap().receipt,
        original
    );
}
#[test]
fn scoped_candidate_rejections_are_durable_and_copy_mutation_is_rechecked() {
    let (_dir, _root, repo) = seed();
    let grant = CreativeGrant {
        whole_tree: false,
        files: vec!["public/clip.bin".into()],
        directories: vec![],
        manuscript_scope: CreativeGrantManuscriptScope {
            kind: CreativeGrantManuscriptScopeKind::None,
            block_ids: vec![],
        },
    };
    let item = ready(&repo, grant, false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "src/Root.tsx", b"escape");
    let item = inspect(&repo, &item);
    assert!(
        item.latest_candidate
            .as_ref()
            .unwrap()
            .blockers
            .contains(&"WORK_OUT_OF_SCOPE".into())
    );
    let r = accept(&item);
    assert_eq!(
        repo.accept_work_candidate(&r).unwrap_err().0,
        "WORK_OUT_OF_SCOPE"
    );
    assert_eq!(
        repo.command_receipt(&r.request_id).unwrap_err().0,
        "WORK_OUT_OF_SCOPE"
    );
    assert_eq!(
        repo.accept_work_candidate(&r).unwrap_err().0,
        "WORK_OUT_OF_SCOPE"
    );
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "public/clip.bin", b"one");
    let item = inspect(&repo, &item);
    put(&copy, "public/clip.bin", b"two");
    let r = accept(&item);
    assert_eq!(
        repo.accept_work_candidate(&r).unwrap_err().0,
        "WORK_CANDIDATE_STALE"
    );
    assert_eq!(
        repo.command_receipt(&r.request_id).unwrap_err().0,
        "WORK_CANDIDATE_STALE"
    );
}
#[test]
fn production_locks_have_five_history_and_separate_text_scope() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "Locked prose\n")).unwrap();
    let block = repo.read_source_snapshot().unwrap().semantic_block_ids[0].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[block],"locked":true,"all":false}),
    );
    let before = repo.read_manuscript().unwrap().blocks;
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "public/new.wav", b"audio");
    let item = inspect(&repo, &item);
    repo.accept_work_candidate(&accept(&item)).unwrap();
    assert_eq!(before, repo.read_manuscript().unwrap().blocks);
    let lock = locks(&repo, "public/new.wav", true);
    repo.set_production_file_locks(&lock).unwrap();
    assert_eq!(
        repo.production_file_locks_page(None).unwrap().records.len(),
        1
    );
    assert_eq!(before, repo.read_manuscript().unwrap().blocks);
    command(&repo, "UndoProject", serde_json::json!({}));
    assert!(
        repo.production_file_locks_page(None)
            .unwrap()
            .records
            .is_empty()
    );
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(
        repo.production_file_locks_page(None).unwrap().records.len(),
        1
    );
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "src/Root.tsx", b"shared dependency changed");
    let item = inspect(&repo, &item);
    assert!(
        item.latest_candidate
            .as_ref()
            .unwrap()
            .blockers
            .contains(&"PRODUCTION_FILE_LOCKED".into())
    );
    let r = accept(&item);
    assert_eq!(
        repo.accept_work_candidate(&r).unwrap_err().0,
        "PRODUCTION_FILE_LOCKED"
    );
    assert_eq!(
        repo.command_receipt(&r.request_id).unwrap_err().0,
        "PRODUCTION_FILE_LOCKED"
    );
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(
        repo.production_file_locks_page(None).unwrap().records.len(),
        1
    );
}
#[test]
fn live_observation_restore_refuses_later_edit_and_preserves_history() {
    let (_dir, root, repo) = seed();
    put(&root, "public/clip.bin", b"external one");
    let item = ready(&repo, whole(), true);
    let item = inspect(&repo, &item);
    let candidate = item.latest_candidate.as_ref().unwrap();
    let g = repo.accepted_file_graph().unwrap().unwrap();
    let r = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: g.hash,
        expected_graph_generation: g.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: Some(candidate.candidate_id.clone()),
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::RestoreAcceptedLive,
    };
    put(&root, "public/clip.bin", b"external two");
    assert_eq!(
        repo.discard_work_item(&r).unwrap_err().0,
        "GRAPH_OBSERVATION_STALE"
    );
    assert_eq!(
        repo.command_receipt(&r.request_id).unwrap_err().0,
        "GRAPH_OBSERVATION_STALE"
    );
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"external two"
    );
    let item = inspect(&repo, &item);
    let mut r = r;
    r.request_id = id();
    r.candidate_id = Some(item.latest_candidate.as_ref().unwrap().candidate_id.clone());
    r.expected_item_revision = item.item_revision;
    let history = repo.read_history().unwrap();
    repo.discard_work_item(&r).unwrap();
    assert_eq!(repo.read_history().unwrap(), history);
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        [0, 255, 1, 128]
    );
}
#[test]
fn copy_limit_start_rejection_replay_and_restart_requires_explicit_retry() {
    let (_dir, root, repo) = seed();
    for _ in 0..5 {
        repo.create_work_item(&create(&repo, whole(), false))
            .unwrap();
    }
    let r = create(&repo, whole(), false);
    assert_eq!(repo.create_work_item(&r).unwrap_err().0, "WORK_COPY_LIMIT");
    assert_eq!(
        repo.command_receipt(&r.request_id).unwrap_err().0,
        "WORK_COPY_LIMIT"
    );
    assert_eq!(repo.create_work_item(&r).unwrap_err().0, "WORK_COPY_LIMIT");
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    assert!(!repo.run_next_work_operation().unwrap());
    let item = repo.work_items_page(None).unwrap().records[0].clone();
    assert_eq!(item.state, WorkItemViewState::Interrupted);
    let control = WorkItemControlRequest {
        request_id: id(),
        project_id: item.project_id,
        work_item_id: item.work_item_id.clone(),
        expected_item_revision: item.item_revision,
        action: WorkItemControlRequestAction::Retry,
    };
    repo.control_work_item(&control).unwrap();
    repo.run_next_work_operation().unwrap();
    assert_eq!(
        repo.work_item(&item.work_item_id).unwrap().state,
        WorkItemViewState::Ready
    );
}
#[test]
fn held_bulk_copy_and_inspection_keep_status_source_and_collection_live() {
    for point in ["work-copy-held", "work-inspection-held"] {
        let (_dir, _root, repo) = seed();
        let repo = Arc::new(repo);
        let item = if point == "work-copy-held" {
            repo.create_work_item(&create(&repo, whole(), false))
                .unwrap()
                .item
                .unwrap()
        } else {
            let item = ready(&repo, whole(), false);
            let g = repo.accepted_file_graph().unwrap().unwrap();
            repo.inspect_work_item(&WorkItemInspectRequest {
                request_id: id(),
                project_id: item.project_id.clone(),
                expected_working_revision: repo.read_manuscript().unwrap().working_revision,
                expected_graph_hash: g.hash,
                expected_graph_generation: g.generation,
                work_item_id: item.work_item_id.clone(),
                expected_item_revision: item.item_revision,
            })
            .unwrap()
            .item
            .unwrap()
        };
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *repo.source_action.lock().unwrap() = Some((
            point.into(),
            Box::new(move || {
                held_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }),
        ));
        let worker = {
            let repo = repo.clone();
            std::thread::spawn(move || repo.run_next_work_operation())
        };
        held_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(
            repo.work_operation(&item.operation_request_id)
                .unwrap()
                .status,
            WorkOperationViewStatus::Running
        );
        assert_eq!(repo.collect_objects(Duration::ZERO).unwrap(), 0);
        repo.save_source(&request(&repo, "Input saved during held external I/O\n"))
            .unwrap();
        assert!(
            repo.read_source_snapshot()
                .unwrap()
                .source
                .contains("Input saved during")
        );
        release_tx.send(()).unwrap();
        let outcome = worker.join().unwrap();
        if point == "work-inspection-held" {
            assert_eq!(outcome.unwrap_err().0, "GRAPH_BASE_MISMATCH");
        } else {
            outcome.unwrap();
        }
    }
}
#[test]
fn authenticated_reader_pages_equal_hash_paths_and_gc_lease() {
    let (_dir, _root, repo) = seed();
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    for n in 0..105 {
        put(&copy, &format!("public/new-{n:03}.bin"), &[0, 255, n as u8]);
    }
    let item = inspect(&repo, &item);
    let candidate = item.latest_candidate.as_ref().unwrap();
    let page = repo
        .work_changes_page(&item.work_item_id, &candidate.candidate_id, None)
        .unwrap();
    assert_eq!(page.records.len(), 100);
    let cursor = page.continuation.unwrap();
    assert_eq!(
        repo.work_changes_page(&item.work_item_id, &candidate.candidate_id, Some(&cursor))
            .unwrap()
            .records
            .len(),
        5
    );
    let another = ready(&repo, whole(), false);
    assert_eq!(
        repo.work_changes_page(
            &another.work_item_id,
            &candidate.candidate_id,
            Some(&cursor)
        )
        .unwrap_err()
        .0,
        "WORK_CANDIDATE_STALE"
    );
    let member = &page.records[0];
    let reader = repo
        .work_candidate_member(
            &item.work_item_id,
            &candidate.candidate_id,
            &member.member_id,
            "after",
        )
        .unwrap();
    assert_eq!(repo.collect_objects(Duration::ZERO).unwrap(), 0);
    let mut bytes = vec![];
    reader.stream(&mut bytes).unwrap();
    assert_eq!(hash(&bytes), member.after_hash.clone().unwrap());
    assert!(
        repo.work_candidate_member(
            &item.work_item_id,
            &candidate.candidate_id,
            &hash(b"foreign"),
            "after"
        )
        .is_err()
    );
}
#[test]
fn concurrent_same_hash_publication_keeps_fd_proof_and_defers_collection() {
    let (_dir, _root, repo) = seed();
    let repo = Arc::new(repo);
    let bytes = vec![0x83u8; 1024 * 1024 + 7];
    let expected = hash(&bytes);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    repo.preparation_leases
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    struct Input {
        bytes: std::io::Cursor<Vec<u8>>,
        barrier: Arc<std::sync::Barrier>,
        waited: bool,
    }
    impl std::io::Read for Input {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let n = std::io::Read::read(&mut self.bytes, out)?;
            if n == 0 && !self.waited {
                self.waited = true;
                self.barrier.wait();
            }
            Ok(n)
        }
    }
    let mut threads = vec![];
    for _ in 0..2 {
        let repo = repo.clone();
        let bytes = bytes.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            repo.object_stream(
                &mut Input {
                    bytes: std::io::Cursor::new(bytes),
                    barrier,
                    waited: false,
                },
                2 * 1024 * 1024,
            )
        }));
    }
    for thread in threads {
        assert_eq!(
            thread.join().unwrap().unwrap(),
            (expected.clone(), bytes.len() as u64)
        );
    }
    assert_eq!(repo.collect_objects(Duration::ZERO).unwrap(), 0);
    assert_eq!(
        repo.read_bounded_object(&expected, 2 * 1024 * 1024)
            .unwrap(),
        bytes
    );
    repo.preparation_leases
        .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn context_captures_only_selected_library_bytes_and_links_without_management() {
    let (_dir, _root, repo) = seed();
    repo.save_source(&request(&repo, "Captured protected prose\n"))
        .unwrap();
    let protected = repo.read_source_snapshot().unwrap().semantic_block_ids[0].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[protected],"locked":true,"all":false}),
    );
    repo.set_production_file_locks(&locks(&repo, "public/clip.bin", true))
        .unwrap();
    let selected = id();
    let unselected = id();
    for (source, url) in [
        (&selected, "https://example.invalid/selected?exact=%2F"),
        (&unselected, "https://example.invalid/unselected"),
    ] {
        command(
            &repo,
            "AddSourceLink",
            serde_json::json!({"sourceId":source,"url":url,"title":source}),
        );
    }
    let intake = id();
    repo.begin_intake(&intake, "evidence.txt", "text/plain")
        .unwrap();
    repo.append_intake(&intake, b"Selected retained context bytes")
        .unwrap();
    let intake = repo.complete_intake(&intake).unwrap();
    let file = id();
    command(
        &repo,
        "AddSourceFile",
        serde_json::json!({"sourceId":file,"intakeId":intake.id,"hash":intake.hash}),
    );
    let mut request = create(&repo, whole(), false);
    request.reference_ids = vec![selected.clone(), file.clone()];
    let item = repo.create_work_item(&request).unwrap().item.unwrap();
    // Removing Library membership after capture cannot remove the pinned context.
    command(
        &repo,
        "RemoveSource",
        serde_json::json!({"sourceId":file,"expectedSourceRevision":1}),
    );
    repo.collect_objects(Duration::ZERO).unwrap();
    repo.run_next_work_operation().unwrap();
    let root = repo.reveal_work_item_location(&item.work_item_id).unwrap();
    assert_eq!(
        std::fs::read(root.join("context").join(format!("{file}.bin"))).unwrap(),
        b"Selected retained context bytes"
    );
    let summary = std::fs::read_to_string(root.join("context/scope.json")).unwrap();
    assert!(summary.contains("https://example.invalid/selected?exact=%2F"));
    assert!(!summary.contains("unselected"));
    let guidance: serde_json::Value = serde_json::from_str(&summary).unwrap();
    assert_eq!(
        guidance["protection"]["workingRevision"],
        request.expected_working_revision
    );
    assert!(
        guidance["protection"]["lockedBlockIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &protected)
    );
    assert_eq!(
        guidance["protection"]["productionFileLocks"][0]["path"],
        "public/clip.bin"
    );
    assert!(
        !root
            .join("context")
            .join(format!("{selected}.bin"))
            .exists()
    );
    assert!(!root.join("project/.scenesparrow").exists());
}

#[test]
fn copy_injections_are_failed_durable_operations_and_inspection_never_executes_scripts() {
    for path in [
        ".scenesparrow/injected.sqlite",
        ".git/config",
        ".ENV.secret",
        "private.pem",
    ] {
        let (_dir, _root, repo) = seed();
        let item = ready(&repo, whole(), false);
        let copy = repo
            .reveal_work_item_location(&item.work_item_id)
            .unwrap()
            .join("project");
        put(&copy, path, b"untrusted payload");
        let graph = repo.accepted_file_graph().unwrap().unwrap();
        let request = WorkItemInspectRequest {
            request_id: id(),
            project_id: item.project_id.clone(),
            expected_working_revision: repo.read_manuscript().unwrap().working_revision,
            expected_graph_hash: graph.hash,
            expected_graph_generation: graph.generation,
            work_item_id: item.work_item_id.clone(),
            expected_item_revision: item.item_revision,
        };
        repo.inspect_work_item(&request).unwrap();
        assert_eq!(
            repo.run_next_work_operation().unwrap_err().0,
            "GRAPH_FORBIDDEN_PATH"
        );
        let original = repo.work_operation(&request.request_id).unwrap();
        assert_eq!(
            original.failure_code.as_deref(),
            Some("GRAPH_FORBIDDEN_PATH")
        );
        assert_eq!(
            repo.inspect_work_item(&request).unwrap().operation,
            original
        );
        assert!(copy.join(path).exists());
    }
    let (_dir, _root, repo) = seed();
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(
        &copy,
        "package.json",
        br#"{"scripts":{"postinstall":"touch NEVER_EXECUTED"}}"#,
    );
    let item = inspect(&repo, &item);
    assert!(item.latest_candidate.is_some());
    assert!(!copy.join("NEVER_EXECUTED").exists());
}

#[test]
fn exact_manuscript_block_grant_keeps_locked_neighbor_and_rejects_unknown_scope() {
    let (_dir, _root, repo) = seed();
    repo.save_source(&request(&repo, "Locked A\n\nEditable B\n"))
        .unwrap();
    let source = repo.read_source_snapshot().unwrap();
    let a = source.semantic_block_ids[0].clone();
    let b = source.semantic_block_ids[1].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[a],"locked":true,"all":false}),
    );
    let before = repo.read_manuscript().unwrap().blocks;
    let grant = CreativeGrant {
        whole_tree: false,
        files: vec!["manuscript.md".into()],
        directories: vec![],
        manuscript_scope: CreativeGrantManuscriptScope {
            kind: CreativeGrantManuscriptScopeKind::Blocks,
            block_ids: vec![b],
        },
    };
    let item = ready(&repo, grant, false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(
        &copy,
        "manuscript.md",
        source.source.replace("Editable B", "Edited B").as_bytes(),
    );
    let item = inspect(&repo, &item);
    assert!(item.latest_candidate.as_ref().unwrap().blockers.is_empty());
    repo.accept_work_candidate(&accept(&item)).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], before[0]);
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    let current = repo.read_source_snapshot().unwrap();
    put(
        &copy,
        "manuscript.md",
        current.source.replace("Locked A", "Changed A").as_bytes(),
    );
    let item = inspect(&repo, &item);
    assert!(
        item.latest_candidate
            .as_ref()
            .unwrap()
            .blockers
            .contains(&"CONTENT_LOCKED".into())
    );
    let accept = accept(&item);
    assert_eq!(
        repo.accept_work_candidate(&accept).unwrap_err().0,
        "CONTENT_LOCKED"
    );
    assert_eq!(
        repo.command_receipt(&accept.request_id).unwrap_err().0,
        "CONTENT_LOCKED"
    );
}

#[test]
fn explicit_cancel_keeps_original_start_and_retry_uses_original_captured_base() {
    let (_dir, _root, repo) = seed();
    let repo = Arc::new(repo);
    let start = repo
        .create_work_item(&create(&repo, whole(), false))
        .unwrap();
    let item = start.item.unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *repo.source_action.lock().unwrap() = Some((
        "work-copy-held".into(),
        Box::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }),
    ));
    let worker = {
        let repo = repo.clone();
        std::thread::spawn(move || repo.run_next_work_operation())
    };
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let control = WorkItemControlRequest {
        request_id: id(),
        project_id: item.project_id,
        work_item_id: item.work_item_id.clone(),
        expected_item_revision: item.item_revision,
        action: WorkItemControlRequestAction::Cancel,
    };
    repo.control_work_item(&control).unwrap();
    release_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err().0, "WORK_CANCELLED");
    assert_eq!(
        repo.work_operation(&item.operation_request_id)
            .unwrap()
            .status,
        WorkOperationViewStatus::Cancelled
    );
    assert_eq!(
        repo.control_work_item(&control)
            .unwrap()
            .operation
            .request_id,
        control.request_id
    );
    let item = repo.work_item(&item.work_item_id).unwrap();
    let retry = WorkItemControlRequest {
        request_id: id(),
        project_id: item.project_id,
        work_item_id: item.work_item_id.clone(),
        expected_item_revision: item.item_revision,
        action: WorkItemControlRequestAction::Retry,
    };
    repo.control_work_item(&retry).unwrap();
    repo.run_next_work_operation().unwrap();
    assert_eq!(
        repo.work_item(&item.work_item_id).unwrap().state,
        WorkItemViewState::Ready
    );
    assert_eq!(
        repo.work_operation(&item.operation_request_id)
            .unwrap()
            .status,
        WorkOperationViewStatus::Cancelled
    );
}

#[test]
fn deliberate_copy_discard_releases_one_slot_and_replay_preserves_a_later_directory() {
    let (_dir, _root, repo) = seed();
    let mut items = vec![];
    for _ in 0..5 {
        items.push(ready(&repo, whole(), false));
    }
    let rejected = create(&repo, whole(), false);
    assert_eq!(
        repo.create_work_item(&rejected).unwrap_err().0,
        "WORK_COPY_LIMIT"
    );
    let item = &items[0];
    let root = repo.reveal_work_item_location(&item.work_item_id).unwrap();
    put(
        &root.join("project"),
        "post-accept-external.txt",
        b"Explicitly discarded private work",
    );
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let discard = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: graph.hash,
        expected_graph_generation: graph.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: None,
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
    };
    let original = repo.discard_work_item(&discard).unwrap().receipt;
    assert!(!root.exists());
    ready(&repo, whole(), false);
    std::fs::create_dir(&root).unwrap();
    put(
        &root,
        "later-third-party.txt",
        b"A later directory is never the original discarded copy",
    );
    assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, original);
    assert!(root.join("later-third-party.txt").exists());
}

#[test]
fn original_inspection_result_is_separate_from_later_current_item_and_receipt_namespaces_conflict()
{
    let (_dir, _root, repo) = seed();
    let start = create(&repo, whole(), false);
    let item = repo.create_work_item(&start).unwrap().item.unwrap();
    let mut command = serde_json::to_value(ManuscriptCommand::StartManualDraft {
        request_id: start.request_id.clone(),
        project_id: start.project_id.clone(),
        expected_working_revision: 0,
        payload: EmptyPayload {},
    })
    .unwrap();
    command["expectedWorkingRevision"] = repo.read_manuscript().unwrap().working_revision.into();
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(command).unwrap())
            .unwrap_err()
            .0,
        "REQUEST_ID_CONFLICT"
    );
    repo.run_next_work_operation().unwrap();
    let item = repo.work_item(&item.work_item_id).unwrap();
    let item = inspect(&repo, &item);
    let original_operation = repo.work_operation(&item.operation_request_id).unwrap();
    let original_candidate = original_operation.candidate.unwrap();
    let later = inspect(&repo, &item);
    assert_ne!(
        later.latest_candidate.as_ref().unwrap().candidate_id,
        original_candidate.candidate_id
    );
    assert_eq!(
        repo.work_operation(&item.operation_request_id)
            .unwrap()
            .candidate
            .unwrap(),
        original_candidate
    );
    let mut accept = accept(&later);
    accept.request_id = start.request_id;
    assert_eq!(
        repo.accept_work_candidate(&accept).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
}

#[test]
fn lock_sidecars_restore_all_five_transitions_and_missing_policy_evidence_refuses_collection() {
    let (_dir, _root, repo) = seed();
    for n in 0..6 {
        repo.set_production_file_locks(&locks(&repo, "public/clip.bin", n % 2 == 0))
            .unwrap();
    }
    assert_eq!(repo.read_history().unwrap().undo_count, 5);
    for _ in 0..5 {
        command(&repo, "UndoProject", serde_json::json!({}));
    }
    for _ in 0..5 {
        command(&repo, "RedoProject", serde_json::json!({}));
    }
    repo.collect_objects(Duration::ZERO).unwrap();
    {
        let c = repo.connection.lock().unwrap();
        c.execute("DELETE FROM history_production_locks WHERE entry_id=(SELECT entry_id FROM history_entry_identities WHERE position=1)",[]).unwrap();
    }
    assert_eq!(
        repo.collect_objects(Duration::ZERO).unwrap_err().0,
        "GRAPH_INVALID"
    );
}

#[test]
fn slow_member_stream_releases_project_writer_and_its_lease_on_failure() {
    let (_dir, _root, repo) = seed();
    let repo = Arc::new(repo);
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    let bytes = vec![0x93u8; 5 * 1024 * 1024 + 3];
    put(&copy, "public/large.bin", &bytes);
    let item = inspect(&repo, &item);
    let candidate = item.latest_candidate.unwrap();
    let page = repo
        .work_changes_page(&item.work_item_id, &candidate.candidate_id, None)
        .unwrap();
    let member = &page.records[0];
    let reader = repo
        .work_candidate_member(
            &item.work_item_id,
            &candidate.candidate_id,
            &member.member_id,
            "after",
        )
        .unwrap();
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    struct SlowOutput {
        held: Option<mpsc::Sender<()>>,
        release: mpsc::Receiver<()>,
        max: usize,
        bytes: Vec<u8>,
    }
    impl std::io::Write for SlowOutput {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(held) = self.held.take() {
                held.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            self.max = self.max.max(bytes.len());
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let stream = std::thread::spawn(move || {
        let mut output = SlowOutput {
            held: Some(held_tx),
            release: release_rx,
            max: 0,
            bytes: vec![],
        };
        reader.stream(&mut output).unwrap();
        output
    });
    held_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    repo.work_item(&item.work_item_id).unwrap();
    repo.save_source(&request(&repo, "Typing survives a slow download\n"))
        .unwrap();
    assert_eq!(repo.collect_objects(Duration::ZERO).unwrap(), 0);
    release_tx.send(()).unwrap();
    let output = stream.join().unwrap();
    assert_eq!(output.bytes, bytes);
    assert!(output.max <= 65536);
    assert_eq!(
        repo.preparation_leases
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let reader = repo
        .work_candidate_member(
            &item.work_item_id,
            &candidate.candidate_id,
            &member.member_id,
            "after",
        )
        .unwrap();
    struct Cancel;
    impl std::io::Write for Cancel {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("cancelled"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(reader.stream(&mut Cancel).is_err());
    assert_eq!(
        repo.preparation_leases
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[test]
fn pre_registration_name_choice_uses_core_display_projection_and_verified_cas() {
    use scenesparrow_application::ProjectRepository;
    let (_dir, root, repo) = super::super::tests::fixture();
    let source = repo.read_source_snapshot().unwrap();
    repo.rename(
        &id(),
        &source.project_id,
        "Untitled project",
        "未命名旧标题",
    )
    .unwrap();
    let view = repo.file_graph_view().unwrap();
    assert!(!view.registered);
    assert_eq!(view.manifest_name.as_deref(), Some("Untitled project"));
    let registration = GraphRegisterRequest {
        request_id: id(),
        project_id: source.project_id.clone(),
        expected_working_revision: source.working_revision,
        expected_source_hash: source.accepted_hash.clone(),
        expected_source_generation: source.generation,
    };
    assert_eq!(
        repo.register_work_file_graph(&registration).unwrap_err().0,
        "GRAPH_NAME_MISMATCH"
    );
    assert_eq!(
        repo.command_receipt(&registration.request_id)
            .unwrap_err()
            .0,
        "GRAPH_NAME_MISMATCH"
    );
    let before = std::fs::read(root.join("project.json")).unwrap();
    let choice = id();
    repo.rename(
        &choice,
        &source.project_id,
        "未命名旧标题",
        view.manifest_name.as_ref().unwrap(),
    )
    .unwrap();
    assert_eq!(repo.read().unwrap().unwrap().title, "Untitled project");
    assert_eq!(std::fs::read(root.join("project.json")).unwrap(), before);
    let mut registration = registration;
    registration.request_id = id();
    repo.register_work_file_graph(&registration).unwrap();
    assert_eq!(repo.read_history().unwrap().undo_count, 0);
}

#[test]
fn explicit_graph_recovery_inspection_keeps_status_live_and_refuses_a_later_intent_state() {
    let (_dir, _root, repo) = seed();
    let repo = Arc::new(repo);
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "public/clip.bin", b"after SQL cut");
    let item = inspect(&repo, &item);
    let accept = accept(&item);
    *repo.source_fault.lock().unwrap() = Some("before-sql".into());
    assert_eq!(
        repo.accept_work_candidate(&accept).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    let pending = repo.source_status().unwrap().pending_intent.unwrap();
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *repo.source_action.lock().unwrap() = Some((
        "work-recovery-inspection-held".into(),
        Box::new(move || {
            held_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }),
    ));
    let inspection = {
        let repo = repo.clone();
        let hash = pending.intent_hash.clone();
        std::thread::spawn(move || repo.inspect_graph_recovery(&hash))
    };
    held_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        repo.source_status()
            .unwrap()
            .pending_intent
            .unwrap()
            .intent_hash,
        pending.intent_hash
    );
    assert_eq!(repo.collect_objects(Duration::ZERO).unwrap(), 0);
    let recover=serde_json::from_value(serde_json::json!({"projectId":item.project_id,"intentHash":pending.intent_hash,"requestId":pending.request_id,"disposition":"known"})).unwrap();
    repo.recover_source(&recover).unwrap();
    repo.save_source(&request(&repo, "New input after recovery\n"))
        .unwrap();
    release_tx.send(()).unwrap();
    assert_eq!(
        inspection.join().unwrap().unwrap_err().0,
        "SOURCE_RECOVERY_STALE"
    );
    assert_eq!(
        repo.preparation_leases
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[test]
fn active_question_keeps_original_run_and_zero_dispatches_during_independent_media_acceptance() {
    let (dir, _root, repo) = seed();
    repo.save_source(&request(&repo, "Question source\n"))
        .unwrap();
    let state = repo.read_manuscript().unwrap();
    let block = &state.blocks[0];
    let text = block
        .runs
        .iter()
        .map(|run| run.text.as_str())
        .collect::<String>();
    let thread = id();
    command(
        &repo,
        "SaveReview",
        serde_json::json!({"expectedRequestVersion":0,"thread":{"id":thread,"kind":"question","requestVersion":0,"text":"Explain this source","anchor":{"ranges":[{"blockId":block.id,"revision":block.revision,"start":0,"end":text.encode_utf16().count(),"quote":text,"wholeBlock":true}],"state":"mapped","slot":null},"handled":false,"deleted":false,"language":"en","evidence":[],"decision":null,"userMessageIds":[]}}),
    );
    let settings =
        crate::ai::settings::SettingsStore::open(&dir.path().join("ai-settings")).unwrap();
    crate::ai::tests::configured(&settings, "none");
    let request:ManuscriptCommand=serde_json::from_value(serde_json::json!({"type":"StartReviewTask","requestId":id(),"projectId":state.manuscript_id,"expectedWorkingRevision":repo.read_manuscript().unwrap().working_revision,"payload":{"threadId":thread,"requestVersion":1}})).unwrap();
    let mut request = serde_json::to_value(request).unwrap();
    request["projectId"] = repo.read_source_snapshot().unwrap().project_id.into();
    let request: ManuscriptCommand = serde_json::from_value(request).unwrap();
    repo.start_review(&settings, &request).unwrap();
    let item = ready(&repo, whole(), false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    put(&copy, "public/independent.wav", b"media only");
    let item = inspect(&repo, &item);
    assert!(item.latest_candidate.as_ref().unwrap().blockers.is_empty());
    repo.accept_work_candidate(&accept(&item)).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks, state.blocks);
    let c = repo.connection.lock().unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM ai_dispatches", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT application FROM review_tasks WHERE run_id=?1",
            [manuscript::envelope(&request).0],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "pending"
    );
}

#[test]
fn narration_declarations_report_availability_divergence_and_adaptation_without_rewriting_locked_prose()
 {
    let (_dir, _root, repo) = seed();
    repo.save_source(&request(&repo, "Locked narration source\n"))
        .unwrap();
    let source = repo.read_source_snapshot().unwrap();
    let state = repo.read_manuscript().unwrap();
    let block = &state.blocks[0];
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[block.id],"locked":true,"all":false}),
    );
    let mut grant = whole();
    grant.manuscript_scope.kind = CreativeGrantManuscriptScopeKind::None;
    let item = ready(&repo, grant, false);
    let copy = repo
        .reveal_work_item_location(&item.work_item_id)
        .unwrap()
        .join("project");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(copy.join("project.json")).unwrap()).unwrap();
    manifest["audio"] = serde_json::json!({"plan":"audio/plan.json"});
    put(
        &copy,
        "project.json",
        &serde_json::to_vec(&manifest).unwrap(),
    );
    let segments=[(block.id.clone(),block.revision),(block.id.clone(),0),(id(),1)].into_iter().enumerate().map(|(n,(source,revision))|{let media=format!("public/take-{n}.wav");put(&copy,&media,b"opaque fixture take");serde_json::json!({"id":id(),"sourceBlockId":source,"sourceRevision":revision,"narrationText":"Adapted spoken text","media":media,"trimStartSample":0,"trimEndSample":100,"placementSample":0,"gainMilliDb":0})}).collect::<Vec<_>>();
    put(&copy,"audio/plan.json",&serde_json::to_vec(&serde_json::json!({"format":"scenesparrow-audio","formatVersion":1,"segments":segments})).unwrap());
    let item = inspect(&repo, &item);
    let candidate = item.latest_candidate.as_ref().unwrap();
    assert!(candidate.blockers.is_empty());
    assert_eq!(
        candidate.provenance[0].status,
        WorkNarrationProvenanceStatus::Available
    );
    assert!(candidate.provenance[0].adapted);
    assert_eq!(
        candidate.provenance[1].status,
        WorkNarrationProvenanceStatus::Diverged
    );
    assert_eq!(
        candidate.provenance[2].status,
        WorkNarrationProvenanceStatus::Missing
    );
    repo.accept_work_candidate(&accept(&item)).unwrap();
    assert_eq!(repo.read_source_snapshot().unwrap().source, source.source);
    assert_eq!(repo.read_manuscript().unwrap().blocks, state.blocks);
}

#[test]
fn discarded_copy_consumed_ownership_survives_identity_reuse_and_restart() {
    let (_dir, project, repo) = seed();
    let item = ready(&repo, whole(), false);
    let root = repo.reveal_work_item_location(&item.work_item_id).unwrap();
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let discard = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: graph.hash,
        expected_graph_generation: graph.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: None,
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
    };
    let receipt = repo.discard_work_item(&discard).unwrap().receipt;
    std::fs::create_dir(&root).unwrap();
    put(
        &root,
        "unknown.txt",
        b"never reacquire consumed pathname ownership",
    );
    // Simulate deterministic device/inode reuse rather than depending on the allocator.
    let owner = Parent::open(
        &repo.directory,
        &format!("work-items/{}/__work__", item.work_item_id),
    )
    .unwrap();
    let identity = serde_json::to_string(&owner.directory_identity().unwrap()).unwrap();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE work_copy_locations SET identity_json=?2 WHERE item_id=?1",
            params![item.work_item_id, identity],
        )
        .unwrap();
    drop(owner);
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&project).unwrap();
    assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, receipt);
    assert!(root.join("unknown.txt").exists());
}

#[test]
fn inspection_and_retry_share_bounded_admission_and_original_rejections() {
    let (_dir, _root, repo) = seed();
    let repo = Arc::new(repo);
    let items: Vec<_> = (0..7).map(|_| ready(&repo, whole(), true)).collect();
    let request_for = |item: &WorkItemView| WorkItemInspectRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: item.creation_revision,
        expected_graph_hash: item.base_graph_hash.clone(),
        expected_graph_generation: item.base_graph_generation,
        work_item_id: item.work_item_id.clone(),
        expected_item_revision: item.item_revision,
    };
    let cancelled = repo
        .inspect_work_item(&request_for(&items[6]))
        .unwrap()
        .item
        .unwrap();
    repo.control_work_item(&WorkItemControlRequest {
        request_id: id(),
        project_id: cancelled.project_id.clone(),
        work_item_id: cancelled.work_item_id.clone(),
        expected_item_revision: cancelled.item_revision,
        action: WorkItemControlRequestAction::Cancel,
    })
    .unwrap();
    let cancelled = repo.work_item(&cancelled.work_item_id).unwrap();
    let retry = WorkItemControlRequest {
        request_id: id(),
        project_id: cancelled.project_id.clone(),
        work_item_id: cancelled.work_item_id.clone(),
        expected_item_revision: cancelled.item_revision,
        action: WorkItemControlRequestAction::Retry,
    };
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    *repo.source_action.lock().unwrap() = Some((
        "work-inspection-held".into(),
        Box::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }),
    ));
    repo.inspect_work_item(&request_for(&items[0])).unwrap();
    let worker = {
        let repo = repo.clone();
        std::thread::spawn(move || repo.run_next_work_operation())
    };
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    for item in &items[1..5] {
        repo.inspect_work_item(&request_for(item)).unwrap();
    }
    let rejected = request_for(&items[5]);
    let inspect_code = repo.inspect_work_item(&rejected).err().map(|e| e.0);
    let retry_code = repo.control_work_item(&retry).err().map(|e| e.0);
    release_tx.send(()).unwrap();
    worker.join().unwrap().unwrap();
    assert_eq!(inspect_code, Some("QUEUE_FULL"));
    assert_eq!(retry_code, Some("QUEUE_FULL"));
    while repo.run_next_work_operation().unwrap() {}
    assert_eq!(
        repo.inspect_work_item(&rejected).unwrap_err().0,
        "QUEUE_FULL"
    );
    assert_eq!(repo.control_work_item(&retry).unwrap_err().0, "QUEUE_FULL");
    for request in [&rejected.request_id, &retry.request_id] {
        assert_eq!(repo.command_receipt(request).unwrap_err().0, "QUEUE_FULL");
    }
    let mut next = retry;
    next.request_id = id();
    repo.control_work_item(&next).unwrap();
    repo.run_next_work_operation().unwrap();
    assert_eq!(
        repo.work_item(&cancelled.work_item_id)
            .unwrap()
            .base_graph_hash,
        cancelled.base_graph_hash
    );
}

#[test]
fn discarded_copy_crash_cuts_preserve_every_interrupted_cleanup_without_reacquisition() {
    for point in [
        "work-discard-before-detach",
        "work-discard-detached",
        "work-discard-detached-replaced",
        "work-discard-cleanup-consumed",
    ] {
        let (_dir, project, repo) = seed();
        let item = ready(&repo, whole(), false);
        let root = repo.reveal_work_item_location(&item.work_item_id).unwrap();
        let graph = repo.accepted_file_graph().unwrap().unwrap();
        let discard = WorkItemDiscardRequest {
            request_id: id(),
            project_id: item.project_id.clone(),
            expected_working_revision: repo.read_manuscript().unwrap().working_revision,
            expected_graph_hash: graph.hash,
            expected_graph_generation: graph.generation,
            work_item_id: item.work_item_id.clone(),
            candidate_id: None,
            expected_item_revision: item.item_revision,
            disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
        };
        *repo.source_fault.lock().unwrap() = Some(
            if point == "work-discard-detached-replaced" {
                "work-discard-detached"
            } else {
                point
            }
            .into(),
        );
        assert_eq!(
            repo.discard_work_item(&discard).unwrap_err().0,
            "STORAGE_UNAVAILABLE"
        );
        let receipt = repo.command_receipt(&discard.request_id).unwrap();
        let stage: String = repo
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT cleanup_stage FROM work_copy_locations WHERE item_id=?1",
                [&item.work_item_id],
                |r| r.get(0),
            )
            .unwrap();
        let detached = repo.directory.join("staging").join(stage);
        let preserved = detached.with_extension("retained");
        if point == "work-discard-detached-replaced" {
            std::fs::rename(&detached, &preserved).unwrap();
            std::fs::create_dir(&detached).unwrap();
            put(
                &detached,
                "unknown-stage.txt",
                b"not the original detached directory",
            );
        }
        std::fs::create_dir_all(&root).unwrap();
        put(
            &root,
            "later-unknown.txt",
            b"retain residual original or later root",
        );
        drop(repo);
        let repo = SqliteProjectRepository::open_format(&project).unwrap();
        assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, receipt);
        assert!(root.join("later-unknown.txt").exists());
        let state: String = repo
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT cleanup_state FROM work_copy_locations WHERE item_id=?1",
                [&item.work_item_id],
                |r| r.get(0),
            )
            .unwrap();
        match point {
            "work-discard-before-detach" => {
                assert_eq!(state, "detaching");
                assert!(!detached.exists());
                assert!(root.join("project").exists());
            }
            "work-discard-detached" => {
                assert_eq!(state, "detached");
                assert!(detached.join("project").exists());
            }
            "work-discard-detached-replaced" => {
                assert_eq!(state, "detached");
                assert!(detached.join("unknown-stage.txt").exists());
                assert!(preserved.join("project").exists());
            }
            _ => {
                assert_eq!(state, "consumed");
                assert!(detached.join("project").exists());
            }
        }
    }
}

#[test]
fn interrupted_discard_never_reacquires_recycled_stage_identity_after_reopen() {
    let (_dir, project, repo) = seed();
    let item = ready(&repo, whole(), false);
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let discard = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: graph.hash,
        expected_graph_generation: graph.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: None,
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
    };
    *repo.source_fault.lock().unwrap() = Some("work-discard-detached".into());
    assert_eq!(
        repo.discard_work_item(&discard).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    let receipt = repo.command_receipt(&discard.request_id).unwrap();
    let stage: String = repo
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT cleanup_stage FROM work_copy_locations WHERE item_id=?1",
            [&item.work_item_id],
            |r| r.get(0),
        )
        .unwrap();
    let path = repo.directory.join("staging").join(&stage);
    std::fs::remove_dir_all(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    put(
        &path,
        "unknown-stage.txt",
        b"recycled identifiers never restore destructive ownership",
    );
    let owner = Parent::open(&repo.directory, &format!("staging/{stage}/__work__")).unwrap();
    // Deterministically model identifier recycling, including when the allocator
    // does not immediately reuse the old inode on this platform.
    let identity = serde_json::to_string(&owner.directory_identity().unwrap()).unwrap();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE work_copy_locations SET identity_json=?2 WHERE item_id=?1",
            params![item.work_item_id, identity],
        )
        .unwrap();
    drop(owner);
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&project).unwrap();
    assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, receipt);
    assert!(path.join("unknown-stage.txt").exists());
    let state: String = repo
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT cleanup_state FROM work_copy_locations WHERE item_id=?1",
            [&item.work_item_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(state, "detached");
}

#[test]
fn discard_after_verification_stage_swap_cannot_redirect_deletion() {
    let (_dir, _project, repo) = seed();
    let repo = Arc::new(repo);
    let item = ready(&repo, whole(), false);
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let discard = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        expected_graph_hash: graph.hash,
        expected_graph_generation: graph.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: None,
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
    };
    let (tx, rx) = mpsc::channel();
    let held = repo.clone();
    let item_id = item.work_item_id.clone();
    *repo.source_action.lock().unwrap() = Some((
        "work-discard-after-stage-verification".into(),
        Box::new(move || {
            let stage: String = held
                .connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT cleanup_stage FROM work_copy_locations WHERE item_id=?1",
                    [item_id],
                    |r| r.get(0),
                )
                .unwrap();
            let stage = held.directory.join("staging").join(stage);
            let original = stage.with_extension("original");
            std::fs::rename(&stage, &original).unwrap();
            std::fs::create_dir(&stage).unwrap();
            put(
                &stage,
                "unknown-stage.txt",
                b"a stage swap never redirects recursive deletion",
            );
            tx.send((stage, original)).unwrap();
        }),
    ));
    let result = repo.discard_work_item(&discard);
    let (stage, original) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(stage.join("unknown-stage.txt").exists());
    assert_eq!(result.unwrap_err().0, "SOURCE_EXTERNAL_CHANGE");
    assert!(original.join("project").exists());
    let receipt = repo.command_receipt(&discard.request_id).unwrap();
    assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, receipt);
    assert!(stage.join("unknown-stage.txt").exists());
}

fn assert_private_copy_cleanup_limit(depth_limit: bool) {
    let (_dir, project, repo) = seed();
    repo.save_source(&request(&repo, "Core manuscript retained\n"))
        .unwrap();
    let item = ready(&repo, whole(), false);
    let root = repo.reveal_work_item_location(&item.work_item_id).unwrap();
    // A mutable external work copy may contain arbitrary extra trees. Keep
    // this fixture small while exercising the real discard/receipt owner.
    for entry in std::fs::read_dir(&root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            std::fs::remove_dir_all(entry.path()).unwrap();
        } else {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
    let leaves = if depth_limit {
        vec!["a/b/c/unknown.txt"]
    } else {
        vec!["a/unknown-a.txt", "b/unknown-b.txt"]
    };
    for path in &leaves {
        put(
            &root,
            path,
            b"retain every leaf beyond the private cleanup budget",
        );
    }
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let canonical = repo.read_manuscript().unwrap();
    let clip = std::fs::read(project.join("public/clip.bin")).unwrap();
    let discard = WorkItemDiscardRequest {
        request_id: id(),
        project_id: item.project_id.clone(),
        expected_working_revision: canonical.working_revision,
        expected_graph_hash: graph.hash.clone(),
        expected_graph_generation: graph.generation,
        work_item_id: item.work_item_id.clone(),
        candidate_id: None,
        expected_item_revision: item.item_revision,
        disposition: WorkItemDiscardRequestDisposition::DiscardCopy,
    };
    let result = super::super::physical::with_discard_cleanup_limits(
        if depth_limit { 2 } else { 64 },
        if depth_limit { 100 } else { 1 },
        || repo.discard_work_item(&discard),
    );
    assert_eq!(result.unwrap_err().0, "STORAGE_UNAVAILABLE");
    let receipt = repo.command_receipt(&discard.request_id).unwrap();
    let (state, stage): (String, String) = repo
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT cleanup_state,cleanup_stage FROM work_copy_locations WHERE item_id=?1",
            [&item.work_item_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, "consumed");
    let stage = repo.directory.join("staging").join(stage);
    for path in &leaves {
        assert_eq!(
            std::fs::read(stage.join(path)).unwrap(),
            b"retain every leaf beyond the private cleanup budget"
        );
    }
    assert_eq!(repo.read_manuscript().unwrap().blocks, canonical.blocks);
    assert_eq!(
        repo.accepted_file_graph().unwrap().unwrap().hash,
        graph.hash
    );
    assert_eq!(
        std::fs::read(project.join("public/clip.bin")).unwrap(),
        clip
    );
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&project).unwrap();
    // Neither a restart nor replay may acquire a fresh cleanup capability,
    // even though its default resource budget is larger than the test cut.
    assert_eq!(repo.discard_work_item(&discard).unwrap().receipt, receipt);
    for path in &leaves {
        assert!(stage.join(path).exists());
    }
}

#[test]
fn private_copy_cleanup_depth_limit_preserves_consumed_stage_and_receipt() {
    assert_private_copy_cleanup_limit(true);
}
#[test]
fn private_copy_cleanup_shared_entry_limit_preserves_consumed_stage_and_receipt() {
    assert_private_copy_cleanup_limit(false);
}
