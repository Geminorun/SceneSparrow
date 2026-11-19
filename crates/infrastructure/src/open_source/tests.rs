use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn fixture() -> (tempfile::TempDir, PathBuf, SqliteProjectRepository) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    let repo = SqliteProjectRepository::create_format(&root).unwrap();
    (dir, root, repo)
}
fn request(repo: &SqliteProjectRepository, text: &str) -> SourceSaveRequest {
    let snapshot = repo.read_source_snapshot().unwrap();
    SourceSaveRequest{request_id:id(),project_id:snapshot.project_id,expected_working_revision:snapshot.working_revision,expected_generation:snapshot.generation,expected_hash:snapshot.accepted_hash,source:text.into(),group:serde_json::from_value(serde_json::json!({"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"})).unwrap()}
}
fn command(
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
    c.execute_batch("DROP TABLE authored_source;DROP TABLE source_operations;DROP TABLE source_pins;PRAGMA user_version=10;CREATE TABLE authored_source(conflict INTEGER);").unwrap();
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
