use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
pub(super) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(super) fn fixture() -> (tempfile::TempDir, PathBuf, SqliteProjectRepository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    let repo = SqliteProjectRepository::create_format(&root).unwrap();
    (dir, root, repo)
}
pub(super) fn request(repo: &SqliteProjectRepository, text: &str) -> SourceSaveRequest {
    let snapshot = repo.read_source_snapshot().unwrap();
    SourceSaveRequest{request_id:id(),project_id:snapshot.project_id,expected_working_revision:snapshot.working_revision,expected_generation:snapshot.generation,expected_hash:snapshot.accepted_hash,source:text.into(),group:serde_json::from_value(serde_json::json!({"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"})).unwrap()}
}
pub(super) fn command(
    repo: &SqliteProjectRepository,
    kind: &str,
    payload: serde_json::Value,
) -> CommandReceipt {
    let snapshot = repo.read_source_snapshot().unwrap();
    let mut raw = serde_json::json!({"type":kind,"requestId":id(),"projectId":snapshot.project_id,"expectedWorkingRevision":snapshot.working_revision,"payload":payload});
    if matches!(kind, "UndoProject" | "RedoProject") {
        let history = repo.read_history().unwrap();
        raw["expectedHistoryRevision"] = history.history_revision.into();
        raw["expectedCursor"] = history.cursor.into();
    }
    repo.execute_manuscript(&serde_json::from_value(raw).unwrap())
        .unwrap()
}
#[test]
fn create_save_replay_history_and_retention() {
    let (_dir, root, repo) = fixture();
    assert_eq!(repo.read_source_snapshot().unwrap().source, "");
    let req = request(
        &repo,
        "# 中文\n\nA **bold** leaf.\n\n- first\n    1. nested\n- last\n\n```text\nunsupported preserved\n```\n",
    );
    let response = repo.save_source(&req).unwrap();
    assert_eq!(response.snapshot.generation, 1);
    assert_eq!(response.snapshot.bindings.len(), 6);
    assert_eq!(response.snapshot.semantic_block_ids.len(), 5);
    assert_eq!(
        std::fs::read(root.join("manuscript.md")).unwrap(),
        response.snapshot.source.as_bytes()
    );
    assert_eq!(repo.save_source(&req).unwrap().receipt, response.receipt);
    let mut reused = req.clone();
    reused.source.push('x');
    assert_eq!(
        repo.save_source(&reused).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    let after = response.snapshot.source;
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, "");
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, after);
    repo.collect_objects(std::time::Duration::ZERO).unwrap();
    drop(repo);
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(reopened.read_source_snapshot().unwrap().source, after);
}
#[test]
fn ordinary_adoption_preserves_meaning_and_management_loss_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let project = id();
    std::fs::write(root.join("project.json"),serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":project,"manuscript":"draft.md"})).unwrap()).unwrap();
    let raw = "\u{feff}# Heading\r\n\r\n- parent\r\n    - child\r\n\r\n> quote\r\n\r\n```md\r\nhello\r\n```\r\n";
    std::fs::write(root.join("draft.md"), raw).unwrap();
    assert!(matches!(
        SqliteProjectRepository::inspect_format(root).unwrap(),
        ProjectInspection::Unmanaged(_)
    ));
    assert_eq!(
        SqliteProjectRepository::open_format(root).err().unwrap().0,
        "SOURCE_ADOPTION_REQUIRED"
    );
    let repo = SqliteProjectRepository::adopt_format(root).unwrap();
    let bound = repo.read_source_snapshot().unwrap();
    assert_eq!(
        source::source_meaning(raw.as_bytes()).unwrap(),
        source::source_meaning(bound.source.as_bytes()).unwrap()
    );
    assert_eq!(bound.project_id, project);
    drop(repo);
    drop(SqliteProjectRepository::open_format(root).unwrap());
    std::fs::remove_file(root.join(".scenesparrow/project.sqlite")).unwrap();
    assert!(matches!(
        SqliteProjectRepository::inspect_format(root).unwrap(),
        ProjectInspection::RecoveryRequired
    ));
    assert_eq!(
        SqliteProjectRepository::open_format(root).err().unwrap().0,
        "SOURCE_RECOVERY_REQUIRED"
    );
    assert!(!root.join(".scenesparrow/project.sqlite").exists());
}
#[test]
fn future_manifest_is_read_only_before_initialization() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("project.json"),
        br#"{"format":"scenesparrow","formatVersion":99,"other":"future"}"#,
    )
    .unwrap();
    assert!(matches!(
        SqliteProjectRepository::inspect_format(dir.path()).unwrap(),
        ProjectInspection::FutureReadOnly {
            format_version: 99,
            ..
        }
    ));
    assert_eq!(
        SqliteProjectRepository::open_format(dir.path())
            .err()
            .unwrap()
            .0,
        "SOURCE_FUTURE_READ_ONLY"
    );
    assert!(!dir.path().join(".scenesparrow").exists());
}
#[test]
fn recovery_at_each_file_and_sql_cut_point() {
    for point in [
        "before-stage",
        "after-stage",
        "before-intent-flush",
        "after-intent",
        "before-promotion",
        "after-promotion",
        "before-sql",
        "after-sql",
        "before-cleanup",
        "after-cleanup",
    ] {
        let (_dir, root, repo) = fixture();
        let req = request(&repo, "New leaf\n");
        *repo.source_fault.lock().unwrap() = Some(point.into());
        assert_eq!(
            repo.save_source(&req).unwrap_err().0,
            "STORAGE_UNAVAILABLE",
            "{point}"
        );
        let committed = matches!(point, "after-sql" | "before-cleanup" | "after-cleanup");
        drop(repo);
        let reopened = SqliteProjectRepository::open_format(&root)
            .unwrap_or_else(|error| panic!("{point}: {error:?}"));
        let snap = reopened.read_source_snapshot().unwrap();
        assert_eq!(snap.generation, if committed { 1 } else { 0 }, "{point}");
        assert_eq!(snap.source.is_empty(), !committed, "{point}");
        if committed {
            let response = reopened.save_source(&req).unwrap();
            assert_eq!(response.receipt.working_revision, snap.working_revision);
        } else {
            assert!(reopened.command_receipt(&req.request_id).is_err());
            reopened.save_source(&req).unwrap();
        }
    }
}
#[test]
fn external_bytes_never_become_accepted_or_get_erased_by_recovery() {
    let (_dir, root, repo) = fixture();
    let req = request(&repo, "App edit\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    repo.save_source(&req).unwrap_err();
    let outside = "Outside editor preserved 中文\n";
    std::fs::write(root.join("manuscript.md"), outside).unwrap();
    assert_eq!(repo.read_source_snapshot().unwrap().source, "");
    assert_eq!(
        repo.read_source_snapshot().unwrap().external_status,
        AuthoredSourceSnapshotExternalStatus::Changed
    );
    drop(repo);
    assert!(SqliteProjectRepository::open_format(&root).is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        outside
    );
    assert_eq!(
        std::fs::read_to_string(
            root.join(".scenesparrow/conflicts")
                .join(hash(outside.as_bytes()))
        )
        .unwrap(),
        outside
    );
}
#[test]
fn stale_base_binding_failures_and_source_only_lock_policy() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "Protected\n\n```text\nunknown\n```\n"))
        .unwrap();
    let current = repo.read_source_snapshot().unwrap();
    let mut stale = request(&repo, &current.source);
    stale.expected_hash = "0".repeat(64);
    assert_eq!(
        repo.save_source(&stale).unwrap_err().0,
        "SOURCE_BASE_MISMATCH"
    );
    assert_eq!(
        repo.save_source(&stale).unwrap_err().0,
        "SOURCE_BASE_MISMATCH"
    );
    let protected = current.semantic_block_ids[0].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[protected],"locked":true,"all":false}),
    );
    assert!(!repo.read_finalization().unwrap().finalized);
    let raw = repo
        .read_source_snapshot()
        .unwrap()
        .source
        .replace("unknown", "format-only");
    let error = repo.save_source(&request(&repo, &raw)).unwrap_err();
    assert_eq!(error.0, "CONTENT_LOCKED");
    let raw = repo
        .read_source_snapshot()
        .unwrap()
        .source
        .replace(&format!("<!-- scenesparrow:block={protected} -->"), "");
    assert_eq!(
        repo.save_source(&request(&repo, &raw)).unwrap_err().0,
        "IDENTITY_MISSING"
    );
}
#[test]
fn supported_list_text_and_root_structural_commands_preserve_other_bytes() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(
        &repo,
        "Start\n\n- first\n    1. child\n- last\n\n```js\nlet x = 1;\n```\n",
    ))
    .unwrap();
    let before = repo.read_source_snapshot().unwrap();
    let state = repo.read_manuscript().unwrap();
    let child = state
        .blocks
        .iter()
        .find(|b| b.runs.iter().any(|r| r.text == "child"))
        .unwrap();
    let edit = serde_json::json!({"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"},"expectedBlockRevisions":[{"id":child.id,"revision":child.revision}],"operations":[{"op":"setBlockContent","id":child.id,"runs":[{"text":"changed","marks":[]}]}]});
    command(&repo, "ApplyDocumentEdit", edit);
    assert_eq!(
        repo.read_source_snapshot().unwrap().source,
        before.source.replace("child", "changed")
    );
    let added = id();
    let payload = serde_json::json!({"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"},"expectedBlockRevisions":[],"operations":[{"op":"insertBlock","after":null,"block":{"id":added,"kind":"paragraph","attrs":{},"runs":[{"text":"Inserted","marks":[]}]}}]});
    command(&repo, "ApplyDocumentEdit", payload);
    let inserted = repo.read_source_snapshot().unwrap().source;
    assert!(inserted.contains("Inserted"));
    assert!(inserted.contains("```js\nlet x = 1;\n```"));
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(
        repo.read_source_snapshot().unwrap().source,
        before.source.replace("child", "changed")
    );
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        inserted
    );
}
#[cfg(unix)]
#[test]
fn physical_symlink_and_replaced_ancestor_are_rejected() {
    use std::os::unix::fs::symlink;
    let (_dir, root, repo) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("other.md");
    std::fs::write(&target, "outside").unwrap();
    std::fs::remove_file(root.join("manuscript.md")).unwrap();
    symlink(&target, root.join("manuscript.md")).unwrap();
    assert_eq!(
        repo.read_source_snapshot().unwrap().external_status,
        AuthoredSourceSnapshotExternalStatus::Unavailable
    );
    assert_eq!(
        repo.save_source(&request(&repo, "new")).unwrap_err().0,
        "SOURCE_PATH_UNSAFE"
    );
    assert_eq!(std::fs::read_to_string(target).unwrap(), "outside");
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    std::fs::write(nested.join("x.md"), "before").unwrap();
    let held = Parent::open(&root, "nested/x.md").unwrap();
    std::fs::rename(&nested, root.join("old")).unwrap();
    symlink(outside.path(), &nested).unwrap();
    assert!(held.stage("stage", b"after").is_err());
    assert!(!outside.path().join("stage").exists());
}
#[test]
fn source_backup_restores_exact_raw_history_and_identity() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(&repo, "# Restored\n\nA **bold** paragraph.\n"))
        .unwrap();
    let first = repo.read_source_snapshot().unwrap();
    repo.save_source(&request(
        &repo,
        &first.source.replace("paragraph", "second"),
    ))
    .unwrap();
    let latest = repo.read_source_snapshot().unwrap();
    let backup = repo.verified_backup().unwrap();
    let target = root.parent().unwrap().join("restored");
    let restored = SqliteProjectRepository::restore_verified_copy(&backup, &target).unwrap();
    assert_eq!(restored.read_source_snapshot().unwrap(), latest);
    command(&restored, "UndoProject", serde_json::json!({}));
    assert_eq!(
        restored.read_source_snapshot().unwrap().source,
        first.source
    );
    assert_eq!(repo.read_source_snapshot().unwrap(), latest);
}
#[test]
fn no_op_and_late_receipt_bind_original_raw_request() {
    let (_dir, _root, repo) = fixture();
    let first = request(&repo, "First\n");
    let receipt = repo.save_source(&first).unwrap().receipt;
    let snapshot = repo.read_source_snapshot().unwrap();
    let unchanged = repo.save_source(&request(&repo, &snapshot.source)).unwrap();
    assert_eq!(unchanged.snapshot.generation, snapshot.generation);
    assert_eq!(
        unchanged.snapshot.working_revision,
        snapshot.working_revision
    );
    repo.save_source(&request(&repo, &snapshot.source.replace("First", "Second")))
        .unwrap();
    assert_eq!(repo.save_source(&first).unwrap().receipt, receipt);
    let mut changed = first;
    changed.source.push('\n');
    assert_eq!(
        repo.save_source(&changed).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
}
#[test]
fn source_only_unknown_changes_are_retained_history_impact() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "A leaf\n\n```text\none\n```\n"))
        .unwrap();
    let before = repo.read_source_snapshot().unwrap();
    let history = repo.read_history().unwrap();
    repo.save_source(&request(&repo, &before.source.replace("one", "two")))
        .unwrap();
    let after = repo.read_source_snapshot().unwrap();
    assert_eq!(after.generation, before.generation + 1);
    assert_eq!(
        repo.read_history().unwrap().history_revision,
        history.history_revision + 1
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
}
#[test]
fn actual_replacement_between_precheck_and_exchange_is_preserved() {
    for replace_inode in [false, true] {
        let (_dir, root, repo) = fixture();
        let req = request(&repo, "App version\n");
        let path = root.join("manuscript.md");
        *repo.source_action.lock().unwrap() = Some((
            "before-promotion".into(),
            Box::new(move || {
                if replace_inode {
                    let replacement = path.with_extension("replacement");
                    std::fs::write(&replacement, "Unseen outside bytes\n").unwrap();
                    std::fs::rename(replacement, &path).unwrap();
                } else {
                    std::fs::write(path, "Unseen outside bytes\n").unwrap();
                }
            }),
        ));
        assert_eq!(
            repo.save_source(&req).unwrap_err().0,
            "SOURCE_EXTERNAL_CHANGE"
        );
        assert_eq!(repo.read_source_snapshot().unwrap().generation, 0);
        assert_eq!(
            std::fs::read_to_string(
                root.join(".scenesparrow/conflicts")
                    .join(hash(b"Unseen outside bytes\n"))
            )
            .unwrap(),
            "Unseen outside bytes\n"
        );
        drop(repo);
        assert!(SqliteProjectRepository::open_format(&root).is_err());
        assert_eq!(
            std::fs::read_to_string(
                root.join(".scenesparrow/conflicts")
                    .join(hash(b"Unseen outside bytes\n"))
            )
            .unwrap(),
            "Unseen outside bytes\n"
        );
    }
}
#[test]
fn complete_supported_exports_use_raw_fingerprint_and_unknown_exports_refuse() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "**Visible**\n")).unwrap();
    let identity = repo.manuscript_identity().unwrap();
    let source = repo.read_source_snapshot().unwrap();
    repo.save_source(&request(
        &repo,
        &source.source.replace("**Visible**", "__Visible__"),
    ))
    .unwrap();
    let changed = repo.manuscript_identity().unwrap();
    assert_ne!(identity.body_hash, changed.body_hash);
    let copy = CopyRequest {
        format: None,
        request_id: id(),
        expected_body_hash: changed.body_hash,
        expected_revision: repo.read_source_snapshot().unwrap().working_revision,
    };
    assert!(repo.prepare_copy(&copy).is_ok());
    let source = repo.read_source_snapshot().unwrap();
    repo.save_source(&request(
        &repo,
        &format!("{}\n```text\nunknown\n```\n", source.source),
    ))
    .unwrap();
    let copy = CopyRequest {
        format: None,
        request_id: id(),
        expected_body_hash: repo.manuscript_identity().unwrap().body_hash,
        expected_revision: repo.read_source_snapshot().unwrap().working_revision,
    };
    assert_eq!(
        repo.prepare_copy(&copy).unwrap_err().0,
        "SOURCE_SEMANTIC_UNSUPPORTED"
    );
}
#[test]
fn management_uuid_mismatch_and_missing_source_row_refuse_without_reinitializing() {
    let (_dir, root, repo) = fixture();
    let old = repo.read_source_snapshot().unwrap();
    drop(repo);
    let path = root.join("project.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["projectId"] = id().into();
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert_eq!(
        SqliteProjectRepository::open_format(&root).err().unwrap().0,
        "SOURCE_PROJECT_MISMATCH"
    );
    manifest["projectId"] = old.project_id.into();
    std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let c = Connection::open(root.join(".scenesparrow/project.sqlite")).unwrap();
    c.execute("DELETE FROM authored_source", []).unwrap();
    drop(c);
    assert!(SqliteProjectRepository::open_format(&root).is_err());
}
#[test]
fn independent_raw_leaf_edit_preserves_another_lock_revision_and_history() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "Locked A\n\nEditable B\n"))
        .unwrap();
    let initial = repo.read_manuscript().unwrap();
    let a = initial.blocks[0].clone();
    let b = initial.blocks[1].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[a.id],"locked":true,"all":false}),
    );
    let thread = id();
    command(
        &repo,
        "SaveReview",
        serde_json::json!({"expectedRequestVersion":0,"thread":{"id":thread,"kind":"question","requestVersion":0,"text":"Keep this anchor","anchor":{"ranges":[{"blockId":a.id,"revision":a.revision,"start":0,"end":8,"quote":"Locked A","wholeBlock":true}],"state":"mapped","slot":null},"handled":false,"deleted":false,"language":"en","evidence":[],"decision":null,"userMessageIds":[]}}),
    );
    let anchored = repo.read_reviews(None).unwrap();
    let source = repo.read_source_snapshot().unwrap();
    let response = repo
        .save_source(&request(
            &repo,
            &source.source.replace("Editable B", "Edited B"),
        ))
        .unwrap();
    assert_eq!(repo.read_reviews(None).unwrap().cards, anchored.cards);
    let edited = repo.read_manuscript().unwrap();
    assert_eq!(edited.blocks[0], a);
    assert!(edited.blocks[1].revision > b.revision);
    assert_eq!(
        repo.read_finalization().unwrap().locks[0].revision,
        a.revision
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, source.source);
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], a);
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(
        repo.read_source_snapshot().unwrap().source,
        response.snapshot.source
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], a);
    assert_eq!(
        repo.save_source(&request(
            &repo,
            &response.snapshot.source.replace("Locked A", "Changed A")
        ))
        .unwrap_err()
        .0,
        "CONTENT_LOCKED"
    );
}
#[test]
fn simple_empty_list_leaves_and_list_insertion_deletion_are_scoped() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "- Parent\n\n    -\n\n- Last\n"))
        .unwrap();
    let before = repo.read_source_snapshot().unwrap();
    let child = repo.read_manuscript().unwrap().blocks[1].clone();
    let edit = |leaf: &str, text: &str, revision: i64| serde_json::json!({"operations":[{"op":"setBlockContent","id":leaf,"runs":if text.is_empty(){vec![]}else{vec![serde_json::json!({"text":text,"marks":[]})]}}],"expectedBlockRevisions":[{"id":leaf,"revision":revision}],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}});
    command(
        &repo,
        "ApplyDocumentEdit",
        edit(&child.id, "Filled child", child.revision),
    );
    let filled = repo.read_source_snapshot().unwrap();
    assert!(
        filled
            .source
            .contains("Filled child<!-- scenesparrow:block=")
    );
    assert!(filled.source.contains("- Parent"));
    let child = repo.read_manuscript().unwrap().blocks[1].clone();
    command(
        &repo,
        "ApplyDocumentEdit",
        edit(&child.id, "", child.revision),
    );
    assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
    let first = repo.read_manuscript().unwrap().blocks[0].clone();
    let added = id();
    command(
        &repo,
        "ApplyDocumentEdit",
        serde_json::json!({"operations":[{"op":"insertBlock","after":child.id,"block":{"id":added,"kind":"list_item","attrs":{"listKind":"bullet","depth":1},"runs":[{"text":"Inserted child","marks":[]}]}}],"expectedBlockRevisions":[{"id":child.id,"revision":repo.read_manuscript().unwrap().blocks[1].revision}],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], first);
    let added = repo
        .read_manuscript()
        .unwrap()
        .blocks
        .iter()
        .find(|block| block.id == added)
        .unwrap()
        .clone();
    command(
        &repo,
        "ApplyDocumentEdit",
        serde_json::json!({"operations":[{"op":"deleteBlock","id":added.id}],"expectedBlockRevisions":[{"id":added.id,"revision":added.revision}],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    );
    assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
}
#[test]
fn append_only_migration_eleven_failure_preserves_legacy_then_retries() {
    use scenesparrow_application::ProjectRepository;
    let directory = tempfile::tempdir().unwrap();
    let repo = SqliteProjectRepository::open(directory.path()).unwrap();
    let project = repo.create("legacy-project", "Legacy project").unwrap();
    let state = repo.read_manuscript().unwrap();
    drop(repo);
    let c = Connection::open(directory.path().join("project.sqlite")).unwrap();
    crate::drop_file_graph_schema_for_legacy_fixture(&c);
    c.execute_batch("DROP TABLE authored_source;DROP TABLE source_operations;DROP TABLE source_pins;DROP TABLE source_candidates;DROP TABLE source_candidate_observation;DROP TABLE source_recovery_evidence;DROP TABLE source_recovery_decisions;ALTER TABLE export_jobs DROP COLUMN serializer_version;PRAGMA user_version=10;CREATE TABLE authored_source(conflict INTEGER);").unwrap();
    assert!(SqliteProjectRepository::open(directory.path()).is_err());
    assert_eq!(
        c.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        10
    );
    assert_eq!(read_project(&c).unwrap(), Some(project.clone()));
    let backup = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pre-migration-011-")
        })
        .unwrap();
    SqliteProjectRepository::inspect_project(&backup).unwrap();
    c.execute_batch("DROP TABLE authored_source").unwrap();
    drop(c);
    let reopened = SqliteProjectRepository::open(directory.path()).unwrap();
    assert_eq!(reopened.read().unwrap(), Some(project));
    assert_eq!(reopened.read_manuscript().unwrap(), state);
}
#[test]
fn unsupported_list_ancestors_keep_descendants_raw_without_orphan_projection() {
    for raw in [
        "- parent ![pic](image.png)\n  - child\n",
        "- first paragraph\n\n  second paragraph\n\n  - child\n",
    ] {
        let (_dir, root, repo) = fixture();
        let result = repo.save_source(&request(&repo, raw)).unwrap();
        assert!(result.snapshot.semantic_block_ids.is_empty());
        assert!(
            result
                .snapshot
                .bindings
                .iter()
                .all(|binding| !binding.semantic_editable)
        );
        assert!(repo.read_manuscript().unwrap().blocks.is_empty());
        assert_eq!(
            source::source_meaning(raw.as_bytes()).unwrap(),
            source::source_meaning(result.snapshot.source.as_bytes()).unwrap()
        );
        drop(repo);
        let reopened = SqliteProjectRepository::open_format(&root).unwrap();
        assert_eq!(
            reopened.read_source_snapshot().unwrap().source,
            result.snapshot.source
        );
    }
}
#[test]
fn missing_live_source_reopens_with_accepted_bytes_and_missing_status() {
    let (_dir, root, repo) = fixture();
    let accepted = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    drop(repo);
    std::fs::remove_file(root.join("manuscript.md")).unwrap();
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    let snapshot = reopened.read_source_snapshot().unwrap();
    assert_eq!(snapshot.source, accepted.source);
    assert_eq!(snapshot.accepted_hash, accepted.accepted_hash);
    assert_eq!(
        snapshot.external_status,
        AuthoredSourceSnapshotExternalStatus::Missing
    );
}
#[test]
fn management_namespace_case_alias_never_initializes_replacement_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::create_dir(root.join(".SceneSparrow")).unwrap();
    std::fs::write(root.join("project.json"),serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":id(),"manuscript":"manuscript.md"})).unwrap()).unwrap();
    std::fs::write(root.join("manuscript.md"), "").unwrap();
    assert_eq!(
        SqliteProjectRepository::adopt_format(root).err().unwrap().0,
        "SOURCE_PATH_UNSAFE"
    );
    assert!(!root.join(".scenesparrow").exists());
}
#[test]
fn first_semantic_draft_can_replace_the_synthetic_empty_source_sentinel() {
    let (_dir, _root, repo) = fixture();
    command(&repo, "StartManualDraft", serde_json::json!({}));
    command(
        &repo,
        "ApplyDocumentEdit",
        serde_json::json!({"operations":[{"op":"insertBlock","after":null,"block":{"id":id(),"kind":"list_item","attrs":{"listKind":"bullet","depth":0},"runs":[{"text":"Initial list draft","marks":[]}]}}],"expectedBlockRevisions":[],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    );
    assert!(
        repo.read_source_snapshot()
            .unwrap()
            .source
            .starts_with("- Initial list draft<!-- scenesparrow:block=")
    );
}
#[test]
fn adoption_never_reinitializes_a_legacy_management_database() {
    use scenesparrow_application::ProjectRepository;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let legacy = SqliteProjectRepository::open(root).unwrap();
    let original = legacy.create("legacy", "Existing legacy identity").unwrap();
    drop(legacy);
    std::fs::write(root.join("project.json"),serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":id(),"manuscript":"manuscript.md"})).unwrap()).unwrap();
    std::fs::write(root.join("manuscript.md"), "Creative source\n").unwrap();
    assert_eq!(
        SqliteProjectRepository::adopt_format(root).err().unwrap().0,
        "SOURCE_MIGRATION_REQUIRED"
    );
    assert!(!root.join(".scenesparrow").exists());
    let c = Connection::open(root.join("project.sqlite")).unwrap();
    assert_eq!(read_project(&c).unwrap(), Some(original));
}
#[test]
fn unresolved_journal_blocks_fast_and_paid_commands_after_receipt_replay() {
    use scenesparrow_application::ai::{AiSettingsPort, ConfigurationGuard};
    struct UntouchedSettings;
    impl AiSettingsPort for UntouchedSettings {
        fn read_settings(&self) -> scenesparrow_domain::ai::Result<AiSettingsView> {
            panic!("recovery must precede settings")
        }
        fn update_settings(
            &self,
            _: &AiSettingsUpdate,
        ) -> scenesparrow_domain::ai::Result<AiSettingsView> {
            panic!("recovery must precede settings")
        }
        fn resolve_configuration(
            &self,
            _: AiCategory,
            _: AiCapability,
        ) -> scenesparrow_domain::ai::Result<AiReadiness> {
            panic!("recovery must precede settings")
        }
        fn with_resolved_configuration(
            &self,
            _: &str,
            _: &mut dyn FnMut(&ConfigurationGuard) -> scenesparrow_domain::ai::Result<()>,
        ) -> scenesparrow_domain::ai::Result<()> {
            panic!("recovery must precede dispatch")
        }
    }
    let (_dir, _root, repo) = fixture();
    let request = request(&repo, "Committed but not cleaned\n");
    *repo.source_fault.lock().unwrap() = Some("after-sql".into());
    assert_eq!(
        repo.save_source(&request).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        repo.save_source(&request).unwrap().receipt.request_id,
        request.request_id
    );
    let snapshot = repo.read_source_snapshot().unwrap();
    let history = repo.read_history().unwrap();
    let base = |kind: &str, payload: serde_json::Value| serde_json::json!({"type":kind,"requestId":id(),"projectId":snapshot.project_id,"expectedWorkingRevision":snapshot.working_revision,"payload":payload});
    let mut close = base(
        "CloseEditGroup",
        serde_json::json!({"groupId":request.group.group_id,"clientSessionId":request.group.client_session_id,"groupSequence":request.group.group_sequence}),
    );
    close["expectedHistoryRevision"] = history.history_revision.into();
    close["expectedCursor"] = history.cursor.into();
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(close).unwrap())
            .unwrap_err()
            .0,
        "SOURCE_RECOVERY_REQUIRED"
    );
    let planning: ManuscriptCommand = serde_json::from_value(base(
        "StartPlanningTask",
        serde_json::json!({"preparationId":id(),"retryOfTaskId":null}),
    ))
    .unwrap();
    assert_eq!(
        repo.start_planning(&UntouchedSettings, &planning)
            .unwrap_err()
            .0,
        "SOURCE_RECOVERY_REQUIRED"
    );
    assert!(
        repo.command_receipt(manuscript::envelope(&planning).0)
            .is_err()
    );
    let review: ManuscriptCommand = serde_json::from_value(base(
        "StartReviewTask",
        serde_json::json!({"threadId":id(),"requestVersion":1}),
    ))
    .unwrap();
    assert_eq!(
        repo.start_review(&UntouchedSettings, &review)
            .unwrap_err()
            .0,
        "SOURCE_RECOVERY_REQUIRED"
    );
    assert!(
        repo.command_receipt(manuscript::envelope(&review).0)
            .is_err()
    );
    assert_eq!(repo.read_history().unwrap(), history);
}
#[test]
fn unicode_protected_root_aliases_reject_inspection_and_adoption_without_writes() {
    fn capture(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn visit(root: &Path, directory: &Path, entries: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let relative = path.strip_prefix(root).unwrap().to_owned();
                if path.is_dir() {
                    entries.insert(relative, None);
                    visit(root, &path, entries);
                } else {
                    entries.insert(relative, Some(std::fs::read(path).unwrap()));
                }
            }
        }
        let mut entries = BTreeMap::new();
        visit(root, root, &mut entries);
        entries
    }
    for alias in [".ſcenesparrow", ".gıt", "project.jſon"] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::write(root.join("project.json"), serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":id(),"manuscript":"manuscript.md"})).unwrap()).unwrap();
        std::fs::write(
            root.join("manuscript.md"),
            "\u{feff}Ordinary **source** 中文\r\n\r\n> Preserve this quote.\r\n",
        )
        .unwrap();
        if alias == "project.jſon" {
            std::fs::write(root.join(alias), b"alias manifest bytes\0\xff").unwrap();
        } else {
            std::fs::create_dir(root.join(alias)).unwrap();
            std::fs::write(
                root.join(alias).join("evidence.bin"),
                b"existing management bytes\0\xff",
            )
            .unwrap();
        }
        let before = capture(root);
        assert_eq!(
            SqliteProjectRepository::inspect_format(root).unwrap_err().0,
            "SOURCE_PATH_UNSAFE",
            "{alias}"
        );
        assert_eq!(capture(root), before, "inspect {alias}");
        assert_eq!(
            SqliteProjectRepository::adopt_format(root).err().unwrap().0,
            "SOURCE_PATH_UNSAFE",
            "{alias}"
        );
        assert_eq!(capture(root), before, "adopt {alias}");
        assert!(!root.join(".scenesparrow").exists(), "{alias}");
    }
}
#[test]
fn canonical_and_near_root_names_allow_ordinary_inspection_adoption_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    std::fs::write(root.join("project.json"), serde_json::to_vec(&serde_json::json!({"format":"scenesparrow","formatVersion":1,"projectId":id(),"manuscript":"manuscript.md"})).unwrap()).unwrap();
    let source = format!(
        "<!-- scenesparrow:block={} -->\r\n\r\nBound ordinary source 中文\r\n",
        id()
    );
    std::fs::write(root.join("manuscript.md"), &source).unwrap();
    let mut preserved = BTreeMap::new();
    for name in [
        ".git",
        ".gitignore-not-a-namespace",
        ".scenesparrow-old",
        ".ſcenesparrow-more",
        ".gıt-near",
    ] {
        std::fs::create_dir(root.join(name)).unwrap();
        let relative = PathBuf::from(name).join("evidence.bin");
        let bytes = format!("Keep {name} exactly\r\n").into_bytes();
        std::fs::write(root.join(&relative), &bytes).unwrap();
        preserved.insert(relative, bytes);
    }
    for name in ["project.json.bak", "project.jſon.bak"] {
        let bytes = format!("Keep {name} exactly\r\n").into_bytes();
        std::fs::write(root.join(name), &bytes).unwrap();
        preserved.insert(PathBuf::from(name), bytes);
    }
    preserved.insert(
        PathBuf::from("project.json"),
        std::fs::read(root.join("project.json")).unwrap(),
    );
    preserved.insert(PathBuf::from("manuscript.md"), source.as_bytes().to_vec());
    assert!(matches!(
        SqliteProjectRepository::inspect_format(root).unwrap(),
        ProjectInspection::Unmanaged(_)
    ));
    let repository = SqliteProjectRepository::adopt_format(root).unwrap();
    assert_eq!(repository.read_source_snapshot().unwrap().source, source);
    for (relative, bytes) in &preserved {
        assert_eq!(
            std::fs::read(root.join(relative)).unwrap(),
            *bytes,
            "{}",
            relative.display()
        );
    }
    drop(repository);
    assert!(matches!(
        SqliteProjectRepository::inspect_format(root).unwrap(),
        ProjectInspection::Managed(_)
    ));
    let reopened = SqliteProjectRepository::open_format(root).unwrap();
    assert_eq!(reopened.read_source_snapshot().unwrap().source, source);
}

fn candidate_request(
    repo: &SqliteProjectRepository,
    disposition: &str,
    proposal: Option<&str>,
) -> AuthoredSourceResolveRequest {
    let status = repo.rescan_source().unwrap();
    let candidate = repo
        .source_candidate(status.candidate_id.as_deref().expect("stable candidate"))
        .unwrap();
    let save = request(repo, "");
    serde_json::from_value(serde_json::json!({"requestId":save.request_id,"projectId":save.project_id,"expectedWorkingRevision":save.expected_working_revision,"expectedGeneration":save.expected_generation,"expectedHash":save.expected_hash,"group":save.group,"candidateId":candidate.id,"candidateHash":candidate.live_hash,"disposition":disposition,"source":proposal})).unwrap()
}
#[test]
fn explicit_resolution_replay_grouped_history_reopen_and_retained_three_versions() {
    let (_dir, root, repo) = fixture();
    let before = repo
        .save_source(&request(&repo, "Local accepted\n\n```raw\nunknown\n```\n"))
        .unwrap()
        .snapshot;
    repo.register_file_graph().unwrap();
    let external = before.source.replace("Local accepted", "External authored");
    std::fs::write(root.join("manuscript.md"), &external).unwrap();
    let r = candidate_request(
        &repo,
        "proposal",
        Some(&before.source.replace("Local accepted", "Combined chosen")),
    );
    let old_history = repo.read_history().unwrap();
    let result = repo.resolve_source(&r).unwrap();
    assert_eq!(result.receipt.undo_count, old_history.undo_count + 1);
    assert!(result.snapshot.source.contains("Combined chosen"));
    assert_eq!(repo.resolve_source(&r).unwrap().receipt, result.receipt);
    let mut changed = r.clone();
    changed.source = Some("changed payload".into());
    assert_eq!(
        repo.resolve_source(&changed).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(
        repo.read_source_snapshot().unwrap().source,
        result.snapshot.source
    );
    repo.collect_objects(Duration::ZERO).unwrap();
    assert_eq!(
        repo.read_object(r.candidate_hash.as_deref().unwrap())
            .unwrap(),
        external.as_bytes()
    );
    drop(repo);
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(
        reopened.read_source_snapshot().unwrap().source,
        result.snapshot.source
    );
    assert_eq!(
        reopened
            .source_candidate(&r.candidate_id)
            .unwrap()
            .disposition,
        AuthoredSourceCandidateDisposition::Proposal
    );
}
#[test]
fn discard_advances_fence_without_prose_history_and_stale_live_never_overwrites() {
    let (_dir, root, repo) = fixture();
    let before = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    std::fs::write(root.join("manuscript.md"), "Outside\n").unwrap();
    let stale = candidate_request(&repo, "discard", None);
    std::fs::write(root.join("manuscript.md"), "Newer outside\n").unwrap();
    assert_eq!(
        repo.resolve_source(&stale).unwrap_err().0,
        "SOURCE_CANDIDATE_STALE"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        "Newer outside\n"
    );
    assert_eq!(
        repo.command_receipt(&stale.request_id).unwrap_err().0,
        "SOURCE_CANDIDATE_STALE"
    );
    assert_eq!(
        repo.resolve_source(&stale).unwrap_err().0,
        "SOURCE_CANDIDATE_STALE"
    );
    let r = candidate_request(&repo, "discard", None);
    let history = repo.read_history().unwrap();
    let result = repo.resolve_source(&r).unwrap();
    assert_eq!(repo.read_history().unwrap(), history);
    assert_eq!(result.snapshot.source, before.source);
    assert_eq!(result.snapshot.generation, before.generation + 1);
    assert_eq!(result.snapshot.working_revision, before.working_revision);
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        before.source
    );
    assert_eq!(repo.resolve_source(&r).unwrap().receipt, result.receipt);
}
#[test]
fn v2_external_fault_cuts_restore_physical_before_separately_from_metadata() {
    for disposition in ["accept", "discard", "proposal"] {
        for cut in [
            "after-intent",
            "before-promotion",
            "after-promotion",
            "before-sql",
            "after-sql",
            "before-cleanup",
        ] {
            let (_dir, root, repo) = fixture();
            let before = repo
                .save_source(&request(&repo, "Accepted\n"))
                .unwrap()
                .snapshot;
            let external = before.source.replace("Accepted", "Outside");
            std::fs::write(root.join("manuscript.md"), &external).unwrap();
            let r = candidate_request(
                &repo,
                disposition,
                if disposition == "proposal" {
                    Some("Chosen combined\n")
                } else {
                    None
                },
            );
            *repo.source_fault.lock().unwrap() = Some(cut.into());
            assert!(repo.resolve_source(&r).is_err(), "{disposition} {cut}");
            let pending = repo.source_status().unwrap().pending_intent.unwrap();
            let raw: Intent =
                serde_json::from_slice(&std::fs::read(repo.intent_path()).unwrap()).unwrap();
            assert_eq!(raw.version, 2);
            assert_ne!(
                raw.changes[0].before_hash.as_ref().unwrap(),
                &raw.accepted.as_ref().unwrap().before_hash
            );
            let mut recovery = AuthoredSourceRecoverRequest {
                disposition: None,
                observation_fingerprint: None,
                project_id: before.project_id.clone(),
                intent_hash: pending.intent_hash.clone(),
                request_id: pending.request_id.clone(),
            };
            recovery.intent_hash = "0".repeat(64);
            assert_eq!(
                repo.recover_source(&recovery).unwrap_err().0,
                "SOURCE_RECOVERY_STALE"
            );
            recovery.intent_hash = pending.intent_hash;
            repo.recover_source(&recovery).unwrap();
            let committed = matches!(cut, "after-sql" | "before-cleanup");
            let current = repo.read_source_snapshot().unwrap();
            if committed {
                assert_eq!(current.generation, before.generation + 1);
                assert_eq!(
                    hash(&std::fs::read(root.join("manuscript.md")).unwrap()),
                    current.accepted_hash
                );
                assert_eq!(
                    repo.resolve_source(&r).unwrap().receipt.request_id,
                    r.request_id
                );
            } else {
                assert_eq!(current.accepted_hash, before.accepted_hash);
                assert_eq!(
                    std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
                    external
                );
                assert_eq!(
                    repo.source_candidate(&r.candidate_id).unwrap().disposition,
                    AuthoredSourceCandidateDisposition::Pending
                );
                repo.resolve_source(&r).unwrap();
            }
            assert!(!repo.intent_path().exists());
        }
    }
}
#[test]
fn recovery_v1_remains_compatible_on_each_side_of_sql() {
    for cut in ["after-promotion", "after-sql"] {
        let (_dir, root, repo) = fixture();
        let before = repo
            .save_source(&request(&repo, "Before\n"))
            .unwrap()
            .snapshot;
        let save = request(&repo, &before.source.replace("Before", "After"));
        *repo.source_fault.lock().unwrap() = Some(cut.into());
        assert!(repo.save_source(&save).is_err());
        // Reconstruct the exact legacy envelope, rather than interpreting v1 as v2.
        let mut intent: Intent =
            serde_json::from_slice(&std::fs::read(repo.intent_path()).unwrap()).unwrap();
        intent.version = 1;
        intent.accepted = None;
        intent.resolution = None;
        let bytes = serde_json::to_vec(&intent).unwrap();
        std::fs::write(repo.intent_path(), &bytes).unwrap();
        repo.connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE source_operations SET intent_hash=?2 WHERE request_id=?1",
                params![save.request_id, hash(&bytes)],
            )
            .unwrap();
        drop(repo);
        let reopened = SqliteProjectRepository::open_format(&root).unwrap();
        assert_eq!(
            reopened
                .read_source_snapshot()
                .unwrap()
                .source
                .contains("After"),
            cut == "after-sql"
        );
    }
}
#[test]
fn source_observation_partial_missing_invalid_missed_events_and_own_echo_do_not_add_history() {
    let (_dir, root, repo) = fixture();
    let saved = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    let history = repo.read_history().unwrap();
    assert_eq!(
        repo.rescan_source().unwrap().external_status,
        AuthoredSourceStatusExternalStatus::Unchanged
    );
    std::fs::write(root.join("manuscript.md"), "partial").unwrap();
    repo.inspect_source_changes(true).unwrap();
    assert_eq!(
        repo.source_status().unwrap().external_status,
        AuthoredSourceStatusExternalStatus::Unstable
    );
    std::fs::remove_file(root.join("manuscript.md")).unwrap();
    assert_eq!(
        repo.rescan_source().unwrap().external_status,
        AuthoredSourceStatusExternalStatus::Missing
    );
    std::fs::write(root.join("manuscript.md"), b"\xff").unwrap();
    assert_eq!(
        repo.rescan_source().unwrap().external_status,
        AuthoredSourceStatusExternalStatus::Invalid
    );
    assert_eq!(repo.read_source_snapshot().unwrap().source, saved.source);
    // No native watcher available/event delivered: explicit rescan still proves bytes.
    {
        let mut o = repo.source_observation.lock().unwrap();
        o.watcher = None;
        o.watch_attempted = true;
    }
    std::fs::write(root.join("manuscript.md"), "Missed rename completed\n").unwrap();
    let status = repo.rescan_source().unwrap();
    assert_eq!(status.watch_mode, AuthoredSourceStatusWatchMode::Polling);
    assert!(status.candidate_id.is_some());
    assert_eq!(repo.read_history().unwrap(), history);
    repo.stop_source_watcher().unwrap();
}
#[test]
fn external_resolution_obeys_actual_leaf_scope_and_unknown_recovery_preserves_bytes() {
    let (_dir, root, repo) = fixture();
    let original = repo
        .save_source(&request(&repo, "A\n\nB\n"))
        .unwrap()
        .snapshot;
    let a = original.semantic_block_ids[0].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[a],"locked":true,"all":false}),
    );
    let locked = repo.read_manuscript().unwrap().blocks[0].clone();
    std::fs::write(
        root.join("manuscript.md"),
        original.source.replace("\nB\n", "\nEdited B\n"),
    )
    .unwrap();
    let r = candidate_request(&repo, "accept", None);
    repo.resolve_source(&r).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], locked);
    let current = repo.read_source_snapshot().unwrap();
    std::fs::write(
        root.join("manuscript.md"),
        current.source.replace("\nA\n", "\nChanged A\n"),
    )
    .unwrap();
    let r = candidate_request(&repo, "accept", None);
    assert_eq!(repo.resolve_source(&r).unwrap_err().0, "CONTENT_LOCKED");
    let discard = candidate_request(&repo, "discard", None);
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    assert!(repo.resolve_source(&discard).is_err());
    std::fs::write(root.join("manuscript.md"), "Unknown after failure\n").unwrap();
    let pending = repo.source_status().unwrap().pending_intent.unwrap();
    let recovery = AuthoredSourceRecoverRequest {
        disposition: None,
        observation_fingerprint: None,
        project_id: current.project_id,
        intent_hash: pending.intent_hash,
        request_id: pending.request_id,
    };
    assert_eq!(
        repo.recover_source(&recovery).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        "Unknown after failure\n"
    );
    assert!(repo.intent_path().exists());
    assert!(
        repo.directory
            .join("conflicts")
            .join(hash(b"Unknown after failure\n"))
            .exists()
    );
}
#[test]
fn clean_markdown_copy_captures_unknown_source_and_literal_marker_code() {
    let (_dir, _root, repo) = fixture();
    let literal = format!("<!-- scenesparrow:block={} -->", id());
    let raw = format!(
        "\u{feff}Body\r\n\r\n```html\r\n{literal}\r\n```\n\n<table>unknown HTML</table>\r\n"
    );
    let saved = repo.save_source(&request(&repo, &raw)).unwrap().snapshot;
    let copy = CopyRequest {
        request_id: id(),
        expected_revision: saved.working_revision,
        expected_body_hash: repo.manuscript_identity().unwrap().body_hash,
        format: Some(CopyRequestFormat::Md),
    };
    let prepared = repo.prepare_copy(&copy).unwrap();
    assert!(prepared.text.contains(&literal));
    assert!(prepared.text.contains("<table>unknown HTML</table>\r\n"));
    assert!(prepared.text.starts_with('\u{feff}'));
    assert!(!prepared.text.contains(&saved.semantic_block_ids[0]));
    repo.save_source(&request(&repo, &saved.source.replace("Body", "New body")))
        .unwrap();
    assert_eq!(repo.prepare_copy(&copy).unwrap(), prepared);
    assert_eq!(repo.prepared_copy(&copy.request_id).unwrap(), prepared);
    assert_ne!(
        repo.manuscript_identity().unwrap().body_hash,
        prepared.body_hash
    );
}

#[test]
fn missing_external_file_restores_without_history_and_recovers_absence_at_fault_cuts() {
    for disposition in ["discard", "proposal"] {
        for cut in ["after-intent", "after-promotion", "before-sql", "after-sql"] {
            let (_dir, root, repo) = fixture();
            let before = repo
                .save_source(&request(&repo, "Accepted before deletion\r\n"))
                .unwrap()
                .snapshot;
            let history = repo.read_history().unwrap();
            std::fs::remove_file(root.join("manuscript.md")).unwrap();
            let r = candidate_request(
                &repo,
                disposition,
                if disposition == "proposal" {
                    Some("Local restored proposal\r\n")
                } else {
                    None
                },
            );
            assert!(r.candidate_hash.is_none());
            let mut accept = r.clone();
            accept.request_id = id();
            accept.disposition = AuthoredSourceResolveRequestDisposition::Accept;
            accept.source = None;
            assert_eq!(
                repo.resolve_source(&accept).unwrap_err().0,
                "SOURCE_REQUIRED_FILE_DELETED"
            );
            *repo.source_fault.lock().unwrap() = Some(cut.into());
            assert!(repo.resolve_source(&r).is_err());
            let intent: Intent =
                serde_json::from_slice(&std::fs::read(repo.intent_path()).unwrap()).unwrap();
            assert!(intent.changes[0].before_hash.is_none());
            assert!(intent.changes[0].before_identity.is_none());
            let pending = repo.source_status().unwrap().pending_intent.unwrap();
            repo.recover_source(&AuthoredSourceRecoverRequest {
                disposition: None,
                observation_fingerprint: None,
                project_id: before.project_id.clone(),
                intent_hash: pending.intent_hash,
                request_id: pending.request_id,
            })
            .unwrap();
            if cut == "after-sql" {
                assert!(root.join("manuscript.md").is_file());
                assert_eq!(
                    repo.read_source_snapshot().unwrap().generation,
                    before.generation + 1
                );
            } else {
                assert!(!root.join("manuscript.md").exists());
                assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
                repo.resolve_source(&r).unwrap();
            }
            if disposition == "discard" {
                assert_eq!(repo.read_history().unwrap(), history);
            }
            assert_eq!(
                hash(&std::fs::read(root.join("manuscript.md")).unwrap()),
                repo.read_source_snapshot().unwrap().accepted_hash
            );
        }
    }
}
#[test]
fn missing_restore_never_clobbers_external_recreation_after_inspection_or_at_promotion() {
    for during_promotion in [false, true] {
        let (_dir, root, repo) = fixture();
        repo.save_source(&request(&repo, "Accepted\n")).unwrap();
        std::fs::remove_file(root.join("manuscript.md")).unwrap();
        let r = candidate_request(&repo, "discard", None);
        let live = root.join("manuscript.md");
        if during_promotion {
            *repo.source_action.lock().unwrap() = Some((
                "before-promotion".into(),
                Box::new(move || std::fs::write(live, "External recreated\n").unwrap()),
            ));
        } else {
            std::fs::write(live, "External recreated\n").unwrap();
        }
        assert!(repo.resolve_source(&r).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
            "External recreated\n"
        );
        if during_promotion {
            assert_eq!(
                repo.recover_source_intents().unwrap_err().0,
                "SOURCE_EXTERNAL_CHANGE"
            );
        }
    }
}

#[test]
fn explicit_preserve_external_recovery_settles_original_and_clears_fence_without_overwrite() {
    for committed in [false, true] {
        for crash_after_decision in [false, true] {
            let (_dir, root, repo) = fixture();
            let before = repo
                .save_source(&request(&repo, "Accepted\n"))
                .unwrap()
                .snapshot;
            let original = request(&repo, &before.source.replace("Accepted", "App pending"));
            *repo.source_fault.lock().unwrap() = Some(
                if committed {
                    "after-sql"
                } else {
                    "after-promotion"
                }
                .into(),
            );
            assert!(repo.save_source(&original).is_err());
            let intent: Intent =
                serde_json::from_slice(&std::fs::read(repo.intent_path()).unwrap()).unwrap();
            let stage = root.join(&intent.changes[0].staged_name);
            std::fs::write(&stage, "Unknown displaced artifact\n").unwrap();
            std::fs::write(root.join("manuscript.md"), "Unknown live external\n").unwrap();
            assert_eq!(
                repo.recover_source_intents().unwrap_err().0,
                "SOURCE_EXTERNAL_CHANGE"
            );
            let status = repo.rescan_source().unwrap();
            let pending = status.pending_intent.unwrap();
            let recovery = AuthoredSourceRecoverRequest {
                project_id: before.project_id.clone(),
                intent_hash: pending.intent_hash,
                request_id: pending.request_id,
                disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
                observation_fingerprint: status.observation_fingerprint,
            };
            if crash_after_decision {
                *repo.source_fault.lock().unwrap() = Some("after-recovery-decision".into());
            }
            let result = repo.recover_source(&recovery);
            if crash_after_decision {
                assert!(result.is_err());
                assert!(repo.intent_path().exists());
                drop(repo);
                let reopened = SqliteProjectRepository::open_format(&root).unwrap();
                assert!(!reopened.intent_path().exists());
                assert_eq!(
                    std::fs::read_to_string(&stage).unwrap(),
                    "Unknown displaced artifact\n"
                );
                assert_eq!(
                    std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
                    "Unknown live external\n"
                );
                assert_eq!(reopened.save_source(&original).is_ok(), committed);
                reopened.recover_source(&recovery).unwrap();
                continue;
            }
            result.unwrap();
            assert!(!repo.intent_path().exists());
            assert_eq!(
                std::fs::read_to_string(stage).unwrap(),
                "Unknown displaced artifact\n"
            );
            assert_eq!(
                std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
                "Unknown live external\n"
            );
            let current = repo.read_source_snapshot().unwrap();
            assert_eq!(current.source.contains("App pending"), committed);
            let replay = repo.save_source(&original);
            if committed {
                assert!(replay.is_ok());
            } else {
                assert_eq!(replay.unwrap_err().0, "SOURCE_EXTERNAL_CHANGE");
            }
            repo.recover_source(&recovery).unwrap();
            let resolution = candidate_request(&repo, "accept", None);
            let accepted = repo.resolve_source(&resolution).unwrap();
            assert!(accepted.snapshot.source.contains("Unknown live external"));
            assert!(
                repo.directory
                    .join("conflicts")
                    .join(hash(b"Unknown displaced artifact\n"))
                    .exists()
            );
        }
    }
}
#[test]
fn preserve_external_recovery_rejects_stale_fingerprint_and_supports_missing_live() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(&repo, "Accepted\n")).unwrap();
    let pending_save = request(&repo, "App edit\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    assert!(repo.save_source(&pending_save).is_err());
    std::fs::write(root.join("manuscript.md"), "External choice\n").unwrap();
    let status = repo.rescan_source().unwrap();
    let pending = status.pending_intent.unwrap();
    let mut recovery = AuthoredSourceRecoverRequest {
        project_id: pending_save.project_id.clone(),
        intent_hash: pending.intent_hash,
        request_id: pending.request_id,
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: status.observation_fingerprint,
    };
    std::fs::write(root.join("manuscript.md"), "New external choice\n").unwrap();
    assert_eq!(
        repo.recover_source(&recovery).unwrap_err().0,
        "SOURCE_RECOVERY_STALE"
    );
    let status = repo.rescan_source().unwrap();
    recovery.observation_fingerprint = status.observation_fingerprint;
    let path = root.join("manuscript.md");
    *repo.source_action.lock().unwrap() = Some((
        "before-recovery-decision".into(),
        Box::new(move || std::fs::remove_file(path).unwrap()),
    ));
    assert_eq!(
        repo.recover_source(&recovery).unwrap_err().0,
        "SOURCE_RECOVERY_STALE"
    );
    recovery.observation_fingerprint = repo.rescan_source().unwrap().observation_fingerprint;
    repo.recover_source(&recovery).unwrap();
    assert!(!root.join("manuscript.md").exists());
    assert!(!repo.intent_path().exists());
    assert_eq!(
        repo.save_source(&pending_save).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    let restore = candidate_request(&repo, "discard", None);
    repo.resolve_source(&restore).unwrap();
    assert!(root.join("manuscript.md").is_file());
}

#[test]
fn watcher_quiesces_without_worker_thread_and_status_never_loads_the_projection() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "Accepted\n")).unwrap();
    repo.rescan_source().unwrap();
    let count = repo
        .business_read_count
        .load(std::sync::atomic::Ordering::Acquire);
    for _ in 0..10 {
        repo.source_status().unwrap();
    }
    assert_eq!(
        repo.business_read_count
            .load(std::sync::atomic::Ordering::Acquire),
        count
    );
    repo.quiesce().unwrap();
    assert_eq!(
        repo.source_status().unwrap().watch_mode,
        AuthoredSourceStatusWatchMode::Stopped
    );
    assert!(repo.source_observation.lock().unwrap().watcher.is_none());
    repo.inspect_source_changes(true).unwrap();
    assert!(repo.source_observation.lock().unwrap().watcher.is_none());
    repo.resume();
    repo.rescan_source().unwrap();
    assert_ne!(
        repo.source_status().unwrap().watch_mode,
        AuthoredSourceStatusWatchMode::Stopped
    );
}
#[test]
fn external_replacement_inside_accept_and_discard_promotion_is_retained_and_blocked() {
    for disposition in ["accept", "discard"] {
        let (_dir, root, repo) = fixture();
        let saved = repo
            .save_source(&request(&repo, "Accepted\n"))
            .unwrap()
            .snapshot;
        std::fs::write(
            root.join("manuscript.md"),
            saved.source.replace("Accepted", "Candidate"),
        )
        .unwrap();
        let r = candidate_request(&repo, disposition, None);
        let live = root.join("manuscript.md");
        *repo.source_action.lock().unwrap() = Some((
            "before-promotion".into(),
            Box::new(move || std::fs::write(live, "Late unseen external\n").unwrap()),
        ));
        assert_eq!(
            repo.resolve_source(&r).unwrap_err().0,
            "SOURCE_EXTERNAL_CHANGE"
        );
        assert!(
            repo.directory
                .join("conflicts")
                .join(hash(b"Late unseen external\n"))
                .exists()
        );
        assert_eq!(
            repo.recover_source_intents().unwrap_err().0,
            "SOURCE_EXTERNAL_CHANGE"
        );
        assert_eq!(
            repo.read_source_snapshot().unwrap().accepted_hash,
            saved.accepted_hash
        );
    }
}

#[test]
fn replay_of_preserve_recovery_cannot_settle_a_newer_pending_operation() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(&repo, "Accepted\n")).unwrap();
    let original = request(&repo, "First failed app edit\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    assert!(repo.save_source(&original).is_err());
    std::fs::write(root.join("manuscript.md"), "Outside choice\n").unwrap();
    let status = repo.rescan_source().unwrap();
    let pending = status.pending_intent.unwrap();
    let recovery = AuthoredSourceRecoverRequest {
        project_id: original.project_id.clone(),
        intent_hash: pending.intent_hash,
        request_id: pending.request_id,
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: status.observation_fingerprint,
    };
    repo.recover_source(&recovery).unwrap();
    let resolution = candidate_request(&repo, "discard", None);
    repo.resolve_source(&resolution).unwrap();
    let next = request(&repo, "New app edit\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    assert!(repo.save_source(&next).is_err());
    let next_intent = std::fs::read(repo.intent_path()).unwrap();
    let live = std::fs::read(root.join("manuscript.md")).unwrap();
    let status = repo.recover_source(&recovery).unwrap();
    assert_eq!(status.pending_intent.unwrap().request_id, next.request_id);
    assert_eq!(std::fs::read(repo.intent_path()).unwrap(), next_intent);
    assert_eq!(std::fs::read(root.join("manuscript.md")).unwrap(), live);
}

#[test]
fn normal_noop_save_cannot_acknowledge_over_an_external_physical_version() {
    let (_dir, root, repo) = fixture();
    let saved = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    let noop = request(&repo, &saved.source);
    std::fs::write(root.join("manuscript.md"), "Outside changed\n").unwrap();
    assert_eq!(
        repo.save_source(&noop).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    assert_eq!(
        repo.read_source_snapshot().unwrap().accepted_hash,
        saved.accepted_hash
    );
    assert_eq!(
        std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
        "Outside changed\n"
    );
}

#[test]
fn automatic_candidates_are_bounded_while_pending_and_explicit_evidence_survive() {
    let (_dir, root, repo) = fixture();
    let saved = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    std::fs::write(root.join("manuscript.md"), "Pending original external\n").unwrap();
    let resolution = candidate_request(&repo, "accept", None);
    *repo.source_fault.lock().unwrap() = Some("after-intent".into());
    assert!(repo.resolve_source(&resolution).is_err());
    let mut observations = vec![];
    for n in 0..15 {
        let raw = format!("External automatic {n} {}\n", "content ".repeat(40));
        std::fs::write(root.join("manuscript.md"), &raw).unwrap();
        let status = repo.rescan_source().unwrap();
        observations.push((status.candidate_id.unwrap(), hash(raw.as_bytes())));
    }
    let current = observations.last().unwrap();
    let c = repo.connection.lock().unwrap();
    let (rows, payload_bytes): (i64, i64) = c
        .query_row(
            "SELECT COUNT(*),SUM(length(payload_json)) FROM source_candidates",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(rows, 7);
    assert!(payload_bytes < 7 * 1500);
    drop(c);
    assert!(repo.source_candidate(&resolution.candidate_id).is_ok());
    assert!(repo.source_candidate(&current.0).is_ok());
    assert_eq!(
        repo.source_candidate(&observations[0].0).unwrap_err().0,
        "SOURCE_CANDIDATE_STALE"
    );
    let roots = repo.retained_object_roots().unwrap();
    assert!(roots.contains(&resolution.candidate_hash.clone().unwrap()));
    assert!(roots.contains(&current.1));
    assert!(!roots.contains(&observations[0].1));
    repo.collect_objects(Duration::ZERO).unwrap();
    assert!(repo.read_object(&observations[0].1).is_err());
    let status = repo.rescan_source().unwrap();
    let pending = status.pending_intent.unwrap();
    repo.recover_source(&AuthoredSourceRecoverRequest {
        project_id: saved.project_id,
        intent_hash: pending.intent_hash,
        request_id: pending.request_id,
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: status.observation_fingerprint,
    })
    .unwrap();
    let preserved = current.clone();
    for n in 15..25 {
        std::fs::write(root.join("manuscript.md"), format!("New automatic {n}\n")).unwrap();
        repo.rescan_source().unwrap();
    }
    repo.prune_source_candidates().unwrap();
    repo.collect_objects(Duration::ZERO).unwrap();
    assert!(repo.source_candidate(&preserved.0).is_ok());
    assert!(repo.read_object(&preserved.1).is_ok());
    let c = repo.connection.lock().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT explicitly_retained FROM source_candidates WHERE id=?1",
            [&preserved.0],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM source_candidates", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        7
    );
}
#[test]
fn original_resolution_receipt_replays_after_automatic_candidate_pruning() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(&repo, "Accepted\n")).unwrap();
    std::fs::write(root.join("manuscript.md"), "External accepted once\n").unwrap();
    let original = candidate_request(&repo, "accept", None);
    let accepted = repo.resolve_source(&original).unwrap();
    for n in 0..9 {
        std::fs::write(root.join("manuscript.md"), format!("Later external {n}\n")).unwrap();
        repo.rescan_source().unwrap();
    }
    assert_eq!(
        repo.source_candidate(&original.candidate_id).unwrap_err().0,
        "SOURCE_CANDIDATE_STALE"
    );
    assert_eq!(
        repo.resolve_source(&original).unwrap().receipt,
        accepted.receipt
    );
    let mut changed = original.clone();
    changed.source = Some("Different proposal".into());
    changed.disposition = AuthoredSourceResolveRequestDisposition::Proposal;
    assert_eq!(
        repo.resolve_source(&changed).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    assert_eq!(
        repo.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM source_candidates", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        6
    );
}

#[test]
fn scoped_recovery_evidence_exposes_unknown_staged_bytes_after_cleanup_and_reopen() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (_dir, root, repo) = fixture();
    let before = repo
        .save_source(&request(&repo, "Accepted\n"))
        .unwrap()
        .snapshot;
    let original = request(&repo, "Local A\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion".into());
    assert!(repo.save_source(&original).is_err());
    let intent_bytes = std::fs::read(repo.intent_path()).unwrap();
    let intent: Intent = serde_json::from_slice(&intent_bytes).unwrap();
    let intent_hash = hash(&intent_bytes);
    let unknown = b"\xef\xbb\xbfUnseen external B\r\n\xff";
    std::fs::write(root.join(&intent.changes[0].staged_name), unknown).unwrap();
    let status = repo.rescan_source().unwrap();
    repo.recover_source(&AuthoredSourceRecoverRequest {
        project_id: before.project_id.clone(),
        request_id: original.request_id,
        intent_hash: intent_hash.clone(),
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: status.observation_fingerprint,
    })
    .unwrap();
    assert!(!repo.intent_path().exists());
    let foreign = repo.object(b"Unrelated management payload").unwrap();
    assert_eq!(
        repo.source_recovery_bytes(&intent_hash, &foreign)
            .unwrap_err()
            .0,
        "OBJECT_NOT_FOUND"
    );
    assert_eq!(
        repo.source_recovery_bytes(&intent_hash, &intent_hash)
            .unwrap_err()
            .0,
        "OBJECT_NOT_FOUND"
    );
    for n in 0..9 {
        std::fs::write(root.join("manuscript.md"), format!("Later {n}\n")).unwrap();
        repo.rescan_source().unwrap();
    }
    repo.collect_objects(Duration::ZERO).unwrap();
    drop(repo);
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    let evidence = reopened.source_recovery_evidence(&intent_hash).unwrap();
    assert_eq!(evidence.project_id, before.project_id);
    assert!(
        !evidence
            .versions
            .iter()
            .any(|v| v.source_hash == intent_hash)
    );
    let staged = evidence
        .versions
        .iter()
        .find(|v| v.source_hash == hash(unknown))
        .unwrap();
    assert_eq!(staged.roles, vec!["staged"]);
    assert!(!staged.utf8);
    assert_eq!(staged.size, unknown.len() as i64);
    let bytes = reopened
        .source_recovery_bytes(&intent_hash, &staged.source_hash)
        .unwrap();
    assert!(bytes.source.is_none());
    assert_eq!(STANDARD.decode(bytes.bytes_base64).unwrap(), unknown);
    let local = evidence
        .versions
        .iter()
        .find(|v| v.roles.contains(&"live".to_string()))
        .unwrap();
    assert!(
        reopened
            .source_recovery_bytes(&intent_hash, &local.source_hash)
            .unwrap()
            .source
            .unwrap()
            .contains("Local A")
    );
}

#[test]
fn source_rejection_receipts_decode_the_original_codes() {
    for code in [
        "SOURCE_CANDIDATE_STALE",
        "SOURCE_CANDIDATE_INVALID",
        "SOURCE_RECOVERY_STALE",
        "SOURCE_REQUIRED_FILE_DELETED",
    ] {
        assert_eq!(
            SqliteProjectRepository::decode(&serde_json::json!({"error":code}).to_string())
                .unwrap_err()
                .0,
            code
        );
    }
}

#[test]
fn multiline_source_projection_is_selectable_and_preserves_raw_locked_neighbors() {
    let (_dir, root, repo) = fixture();
    let a = "11111111-1111-4111-8111-111111111111";
    let b = "22222222-2222-4222-8222-222222222222";
    let raw = format!(
        "\u{feff}<!-- scenesparrow:block={a} -->\r\n\r\nLocked A\r\n\r\n<!-- scenesparrow:block={b} -->\n\nOne\r\nsoft  \r\nhard ` \r\n中😀\r\n ` and `   ` and `literal &amp; \\*`\n"
    );
    let saved = repo.save_source(&request(&repo, &raw)).unwrap();
    assert_eq!(saved.snapshot.source, raw);
    assert_eq!(saved.snapshot.semantic_block_ids.len(), 2);
    let before = repo.read_manuscript().unwrap();
    let text = before.blocks[1]
        .runs
        .iter()
        .map(|run| run.text.as_str())
        .collect::<String>();
    assert_eq!(text, "One\nsoft\nhard  中😀  and     and literal &amp; \\*");
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[a],"locked":true,"all":false}),
    );
    let edited = raw.replace("soft", "edited");
    repo.save_source(&request(&repo, &edited)).unwrap();
    assert_eq!(
        repo.read_manuscript().unwrap().blocks[0].revision,
        before.blocks[0].revision
    );
    assert_eq!(
        std::fs::read(root.join("manuscript.md")).unwrap(),
        edited.as_bytes()
    );
}

#[test]
fn proved_root_structural_history_keeps_locked_a_and_its_review_anchor() {
    let (_dir, root, repo) = fixture();
    repo.register_file_graph().unwrap();
    let a = "11111111-1111-4111-8111-111111111111";
    let b = "22222222-2222-4222-8222-222222222222";
    let raw = format!(
        "\u{feff}<!-- scenesparrow:block={a} -->\r\n\r\nLocked A\r\n\r\n<!-- scenesparrow:block={b} -->\n\nB\n"
    );
    repo.save_source(&request(&repo, &raw)).unwrap();
    let before = repo.read_manuscript().unwrap();
    let revision = before.blocks[0].revision;
    command(
        &repo,
        "SaveReview",
        serde_json::json!({"thread":{"id":id(),"kind":"question","requestVersion":0,"text":"Keep A anchored","anchor":{"ranges":[{"blockId":a,"revision":revision,"start":0,"end":8,"quote":"Locked A","wholeBlock":true}],"state":"mapped","slot":null},"handled":false,"deleted":false,"language":"en","evidence":[],"decision":null,"userMessageIds":[]},"expectedRequestVersion":0}),
    );
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[a],"locked":true,"all":false}),
    );
    let anchor = repo.read_reviews(None).unwrap().cards[0]
        .thread
        .anchor
        .clone();
    let inserted = format!("{raw}\nCopied new leaf 中文\n");
    let saved = repo.save_source(&request(&repo, &inserted)).unwrap();
    assert_eq!(saved.snapshot.semantic_block_ids.len(), 3);
    assert_eq!(repo.read_manuscript().unwrap().blocks[0].revision, revision);
    assert_eq!(
        repo.read_reviews(None).unwrap().cards[0].thread.anchor,
        anchor
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, raw);
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(
        repo.read_source_snapshot().unwrap().source,
        saved.snapshot.source
    );
    repo.save_source(&request(&repo, &raw)).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[0].revision, revision);
    for unsafe_source in [
        format!(
            "{}\nAnother new leaf",
            raw.replacen("Locked A\r\n\r\n", "Locked A\n\n", 1)
        ),
        format!("{raw}\n```text\nunknown\n```\n"),
        format!("{}\nNew leaf", raw.replacen("Locked A", "Changed A", 1)),
    ] {
        assert!(repo.save_source(&request(&repo, &unsafe_source)).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("manuscript.md")).unwrap(),
            raw
        );
    }
    assert_eq!(
        repo.read_reviews(None).unwrap().cards[0].thread.anchor,
        anchor
    );
}
