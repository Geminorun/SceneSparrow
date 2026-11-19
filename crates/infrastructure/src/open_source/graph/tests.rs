use super::super::tests::{command, fixture, id, request};
use super::*;
use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
pub(super) fn put(root: &Path, path: &str, bytes: &[u8]) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}
pub(super) fn seed() -> (tempfile::TempDir, PathBuf, SqliteProjectRepository) {
    let (dir, root, repo) = fixture();
    put(&root, "public/clip.bin", &[0, 255, 1, 128]);
    put(&root, "public/twin.bin", &[0, 255, 1, 128]);
    put(&root, "src/Root.tsx", b"export const Root=()=>null;");
    put(&root, "pnpm-lock.yaml", b"lockfileVersion: 9\n");
    repo.register_file_graph().unwrap();
    (dir, root, repo)
}
fn candidate(repo: &SqliteProjectRepository, changes: &[(&str, Option<&[u8]>)]) -> GraphBatch {
    let current = repo.accepted_file_graph().unwrap().unwrap();
    let mut graph = current.graph;
    for (path, bytes) in changes {
        graph.files.retain(|f| f.path != *path);
        if let Some(bytes) = bytes {
            graph.files.push(GraphFile {
                path: (*path).into(),
                hash: repo.object(bytes).unwrap(),
                size: bytes.len() as u64,
            });
        }
    }
    graph.files.sort_by(|a, b| a.path.cmp(&b.path));
    GraphBatch {
        request_id: id(),
        project_id: graph.project_id.clone(),
        expected_working_revision: repo.read_manuscript().unwrap().working_revision,
        base_hash: current.hash,
        expected_generation: current.generation,
        candidate_hash: repo.object(&serde_json::to_vec(&graph).unwrap()).unwrap(),
    }
}
fn assert_graph_physical(repo: &SqliteProjectRepository, root: &Path) {
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    for file in graph.graph.files {
        assert_eq!(
            hash(&std::fs::read(root.join(&file.path)).unwrap()),
            file.hash,
            "{}",
            file.path
        );
    }
}
#[cfg(target_os = "linux")]
fn mutate_object_stage(directory: &Path, replace: bool) -> PathBuf {
    let stage = std::fs::read_dir(directory.join("staging"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".object-stage-")
        })
        .unwrap();
    if replace {
        std::fs::rename(&stage, stage.with_extension("displaced")).unwrap();
    }
    std::fs::write(&stage, b"unexpected third-party bytes").unwrap();
    stage
}
#[cfg(target_os = "linux")]
struct StageMutatingReader {
    input: std::io::Cursor<Vec<u8>>,
    at_eof: bool,
    action: Option<Box<dyn FnOnce()>>,
    fail: bool,
}
#[cfg(target_os = "linux")]
impl std::io::Read for StageMutatingReader {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if (!self.at_eof || self.input.position() == self.input.get_ref().len() as u64)
            && let Some(action) = self.action.take()
        {
            action();
            if self.fail {
                return Err(std::io::Error::other("injected input failure"));
            }
        }
        std::io::Read::read(&mut self.input, output)
    }
}
#[test]
#[cfg(target_os = "linux")]
fn object_stream_refuses_substituted_or_rewritten_stage_and_preserves_evidence() {
    for (replace, at_eof) in [(true, false), (true, true), (false, true)] {
        let (_dir, _root, repo) = fixture();
        let directory = repo.directory.clone();
        let original = b"original streamed binary\0\xff";
        let mut input = StageMutatingReader {
            input: std::io::Cursor::new(original.to_vec()),
            at_eof,
            action: Some(Box::new(move || {
                mutate_object_stage(&directory, replace);
            })),
            fail: false,
        };
        let result = repo.object_stream(&mut input, 1024);
        assert!(
            result.is_err(),
            "replace={replace}, at_eof={at_eof}: {result:?}"
        );
        assert!(!repo.directory.join("objects").join(hash(original)).exists());
        assert!(
            std::fs::read_dir(repo.directory.join("staging"))
                .unwrap()
                .any(|entry| std::fs::read(entry.unwrap().path()).unwrap()
                    == b"unexpected third-party bytes")
        );
    }
}
#[test]
#[cfg(target_os = "linux")]
fn object_stream_input_failure_preserves_substituted_stage() {
    let (_dir, _root, repo) = fixture();
    let directory = repo.directory.clone();
    let mut input = StageMutatingReader {
        input: std::io::Cursor::new(b"original".to_vec()),
        at_eof: false,
        action: Some(Box::new(move || {
            mutate_object_stage(&directory, true);
        })),
        fail: true,
    };
    assert_eq!(
        repo.object_stream(&mut input, 1024).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert!(
        std::fs::read_dir(repo.directory.join("staging"))
            .unwrap()
            .any(|entry| std::fs::read(entry.unwrap().path()).unwrap()
                == b"unexpected third-party bytes")
    );
}
#[test]
#[cfg(target_os = "linux")]
fn object_stream_verifies_promoted_identity_and_bytes_without_removing_unknown_target() {
    for replace in [true, false] {
        let (_dir, _root, repo) = fixture();
        let original = b"promoted binary\0\xff";
        let digest = hash(original);
        let target = repo.directory.join("objects").join(&digest);
        let changed = target.clone();
        *repo.source_action.lock().unwrap() = Some((
            format!("object-stage-promoted:{digest}"),
            Box::new(move || {
                if replace {
                    std::fs::rename(&changed, changed.with_extension("displaced")).unwrap();
                }
                std::fs::write(changed, b"unexpected target").unwrap();
            }),
        ));
        assert_eq!(
            repo.object_stream(&mut std::io::Cursor::new(original), 1024)
                .unwrap_err()
                .0,
            "STORAGE_UNAVAILABLE"
        );
        assert_eq!(std::fs::read(target).unwrap(), b"unexpected target");
    }
}
#[test]
#[cfg(target_os = "linux")]
fn graph_registration_refuses_corrupted_binary_promotion_without_committing_root() {
    for replace in [true, false] {
        let (_dir, root, repo) = fixture();
        let original = b"unique registration binary\0\xff";
        put(&root, "public/unique.bin", original);
        let before = repo.read_history().unwrap();
        let directory = repo.directory.clone();
        *repo.source_action.lock().unwrap() = Some((
            format!("object-stage-written:{}", hash(original)),
            Box::new(move || {
                mutate_object_stage(&directory, replace);
            }),
        ));
        let result = repo.register_file_graph();
        assert!(
            result.is_err(),
            "corrupt binary registration succeeded: {result:?}"
        );
        assert!(repo.accepted_file_graph().unwrap().is_none());
        assert_eq!(repo.read_history().unwrap(), before);
        assert_eq!(
            std::fs::read(root.join("public/unique.bin")).unwrap(),
            original
        );
        assert!(
            std::fs::read_dir(repo.directory.join("staging"))
                .unwrap()
                .any(|entry| std::fs::read(entry.unwrap().path()).unwrap()
                    == b"unexpected third-party bytes")
        );
    }
}
#[test]
fn registration_inventory_unicode_secrets_links_and_small_budgets() {
    let (_dir, root, repo) = fixture();
    put(&root, ".env", b"excluded");
    put(&root, "node_modules/pkg/index.js", b"excluded");
    put(&root, "public/movie.bin", &[4; 129]);
    let before = repo.read_history().unwrap();
    let graph = repo.register_file_graph().unwrap();
    assert_eq!(before, repo.read_history().unwrap());
    assert_eq!(graph.graph.files.len(), 3);
    assert_eq!(
        repo.inventory_file_graph(&root, true, GraphBudgets::default())
            .unwrap_err()
            .0,
        "GRAPH_FORBIDDEN_PATH"
    );
    assert_eq!(
        repo.inventory_file_graph(
            &root,
            false,
            GraphBudgets {
                files: 2,
                ..GraphBudgets::default()
            }
        )
        .unwrap_err()
        .0,
        "GRAPH_BUDGET_EXCEEDED"
    );
    assert_eq!(
        repo.inventory_file_graph(
            &root,
            false,
            GraphBudgets {
                per_file: 128,
                ..GraphBudgets::default()
            }
        )
        .unwrap_err()
        .0,
        "GRAPH_BUDGET_EXCEEDED"
    );
    assert_eq!(
        repo.inventory_file_graph(
            &root,
            false,
            GraphBudgets {
                aggregate: 1,
                ..GraphBudgets::default()
            }
        )
        .unwrap_err()
        .0,
        "GRAPH_BUDGET_EXCEEDED"
    );
    put(&root, "public/MOVIE.bin", b"alias");
    assert_eq!(
        repo.inventory_file_graph(&root, false, GraphBudgets::default())
            .unwrap_err()
            .0,
        "PATH_COLLISION"
    );
    std::fs::remove_file(root.join("public/MOVIE.bin")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("movie.bin", root.join("public/link.bin")).unwrap();
        assert_eq!(
            repo.inventory_file_graph(&root, false, GraphBudgets::default())
                .unwrap_err()
                .0,
            "SOURCE_PATH_UNSAFE"
        );
        std::fs::remove_file(root.join("public/link.bin")).unwrap();
        std::fs::hard_link(root.join("public/movie.bin"), root.join("public/hard.bin")).unwrap();
        assert_eq!(
            repo.inventory_file_graph(&root, false, GraphBudgets::default())
                .unwrap_err()
                .0,
            "SOURCE_PATH_UNSAFE"
        );
    }
}
#[test]
fn grouped_binary_source_rename_history_replay_and_backup_roundtrip() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "A leaf\n\nB leaf\n"))
        .unwrap();
    let snapshot = repo.read_source_snapshot().unwrap();
    let locked = snapshot.semantic_block_ids[0].clone();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[locked],"locked":true,"all":false}),
    );
    let blocks = repo.read_manuscript().unwrap().blocks;
    let batch = candidate(
        &repo,
        &[
            ("public/clip.bin", Some(&[9, 128, 7])),
            ("src/Root.tsx", None),
            ("nested/new/file.dat", Some(b"new")),
        ],
    );
    let receipt = repo.accept_file_graph(&batch).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks, blocks);
    assert_eq!(receipt.block_revisions.len(), 0);
    assert_graph_physical(&repo, &root);
    let renamed = repo
        .rename(
            "normal-rename",
            &batch.project_id,
            "Untitled project",
            "中文 film",
        )
        .unwrap();
    assert_eq!(renamed.title, "中文 film");
    assert_eq!(repo.read_manuscript().unwrap().blocks, blocks);
    assert_eq!(
        repo.rename(
            "normal-rename",
            &batch.project_id,
            "Untitled project",
            "中文 film"
        )
        .unwrap()
        .title,
        "中文 film"
    );
    assert_eq!(repo.accept_file_graph(&batch).unwrap(), receipt);
    let mut altered = batch.clone();
    altered.candidate_hash = altered.base_hash.clone();
    assert_eq!(
        repo.accept_file_graph(&altered).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read().unwrap().unwrap().title, "Untitled project");
    assert_graph_physical(&repo, &root);
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        [0, 255, 1, 128]
    );
    assert!(!root.join("nested/new/file.dat").exists());
    assert_graph_physical(&repo, &root);
    command(&repo, "RedoProject", serde_json::json!({}));
    command(&repo, "RedoProject", serde_json::json!({}));
    let raw = repo
        .read_source_snapshot()
        .unwrap()
        .source
        .replace("B leaf", "B changed");
    repo.save_source(&request(&repo, &raw)).unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[0], blocks[0]);
    assert_graph_physical(&repo, &root);
    repo.collect_objects(std::time::Duration::ZERO).unwrap();
    {
        let c = repo.connection.lock().unwrap();
        repo.verify_history(&c, &repo.load(&c).unwrap()).unwrap();
        repo.verify_file_graph_history(&c).unwrap();
        repo.verify_finalization(&c, &repo.load(&c).unwrap())
            .unwrap();
    }
    SqliteProjectRepository::inspect_project(&repo.directory).unwrap();
    let backup = repo.verified_backup().unwrap();
    let restored =
        SqliteProjectRepository::restore_verified_copy(&backup, &root.with_file_name("restored"))
            .unwrap();
    assert_graph_physical(&restored, &root.with_file_name("restored"));
    assert_eq!(restored.read().unwrap().unwrap().title, "中文 film");
    drop(restored);
    drop(repo);
    let reopened = SqliteProjectRepository::open_format(&root).unwrap();
    assert_graph_physical(&reopened, &root);
    assert_eq!(reopened.read_history().unwrap().undo_count, 5);
}
#[test]
fn each_member_sql_cleanup_cut_recovers_a_complete_graph() {
    for point in [
        "after-intent",
        "before-promotion-0",
        "after-promotion-0",
        "after-promotion-1",
        "after-promotion-2",
        "before-sql",
        "after-sql",
        "before-cleanup",
        "after-cleanup-0",
        "after-cleanup-1",
    ] {
        let (_dir, root, repo) = seed();
        let before = repo.accepted_file_graph().unwrap().unwrap();
        let batch = candidate(
            &repo,
            &[
                ("public/clip.bin", Some(b"replacement")),
                ("src/Root.tsx", None),
                ("nested/new.dat", Some(b"addition")),
            ],
        );
        *repo.source_fault.lock().unwrap() = Some(point.into());
        assert_eq!(
            repo.accept_file_graph(&batch).unwrap_err().0,
            "STORAGE_UNAVAILABLE",
            "{point}"
        );
        let committed = matches!(
            point,
            "after-sql" | "before-cleanup" | "after-cleanup-0" | "after-cleanup-1"
        );
        drop(repo);
        let repo = SqliteProjectRepository::open_format(&root)
            .unwrap_or_else(|e| panic!("{point}: {e:?}"));
        assert_graph_physical(&repo, &root);
        assert_eq!(
            repo.accepted_file_graph().unwrap().unwrap().hash,
            if committed {
                batch.candidate_hash.clone()
            } else {
                before.hash
            },
            "{point}"
        );
        assert_eq!(
            repo.read_history().unwrap().undo_count,
            if committed { 1 } else { 0 }
        );
        repo.accept_file_graph(&batch).unwrap();
        assert_graph_physical(&repo, &root);
    }
}
#[test]
fn unknown_second_member_fences_all_and_preserves_path_aware_evidence() {
    let (_dir, root, repo) = seed();
    let before = repo.accepted_file_graph().unwrap().unwrap();
    let batch = candidate(
        &repo,
        &[
            ("public/clip.bin", Some(b"after")),
            ("src/Root.tsx", Some(b"new source")),
        ],
    );
    *repo.source_fault.lock().unwrap() = Some("after-promotion-0".into());
    assert!(repo.accept_file_graph(&batch).is_err());
    put(&root, "src/Root.tsx", b"third-party");
    let journal = std::fs::read(repo.intent_path()).unwrap();
    let intent_hash = hash(&journal);
    assert_eq!(
        repo.recover_source_intents().unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), before);
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"after"
    );
    let request = AuthoredSourceRecoverRequest {
        project_id: batch.project_id.clone(),
        request_id: batch.request_id.clone(),
        intent_hash: intent_hash.clone(),
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: Some(repo.graph_recovery_fingerprint(&intent_hash).unwrap()),
    };
    repo.recover_source(&request).unwrap();
    assert_eq!(
        std::fs::read(root.join("src/Root.tsx")).unwrap(),
        b"third-party"
    );
    assert!(!repo.intent_path().exists());
    let members = repo.graph_recovery_members(&intent_hash, 0, 200).unwrap();
    let equal = members
        .iter()
        .filter(|m| m.role == "acceptedBefore" && m.hash == hash(&[0, 255, 1, 128]))
        .map(|m| m.path.as_str())
        .collect::<BTreeSet<_>>();
    assert!(equal.contains("public/clip.bin") && equal.contains("public/twin.bin"));

    assert!(
        members.iter().any(|m| m.path == "src/Root.tsx"
            && m.role == "live"
            && m.hash == hash(b"third-party"))
    );
    let mut output = vec![];
    repo.stream_graph_recovery_member(
        &intent_hash,
        "src/Root.tsx",
        "live",
        &hash(b"third-party"),
        &mut output,
    )
    .unwrap();
    assert_eq!(output, b"third-party");
    assert_eq!(
        repo.accept_file_graph(&batch).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    assert_eq!(
        repo.command_receipt(&batch.request_id).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    repo.collect_objects(std::time::Duration::ZERO).unwrap();
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    repo.recover_source(&request).unwrap();
    assert_eq!(
        repo.graph_recovery_members(&intent_hash, 0, 200)
            .unwrap()
            .len(),
        members.len()
    );
}
#[test]
fn observed_non_manuscript_accept_discard_absence_and_stale_identity_are_bound() {
    let (_dir, root, repo) = seed();
    let baseline = repo.accepted_file_graph().unwrap().unwrap();
    put(&root, "public/clip.bin", b"external replacement");
    put(&root, "new/external.bin", b"external addition");
    std::fs::remove_file(root.join("src/Root.tsx")).unwrap();
    let observation = repo.observe_file_graph().unwrap();
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), baseline);
    let mut accept = candidate(&repo, &[]);
    accept.candidate_hash = observation.graph_hash().into();
    let receipt = repo
        .accept_observed_file_graph(&accept, &observation)
        .unwrap();
    assert_eq!(receipt.undo_count, 1);
    assert_graph_physical(&repo, &root);
    assert_eq!(
        repo.accept_observed_file_graph(&accept, &observation)
            .unwrap(),
        receipt
    );
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_graph_physical(&repo, &root);
    assert!(!root.join("new/external.bin").exists());
    put(&root, "public/clip.bin", b"discard me");
    put(&root, "discard/add.bin", b"remove me");
    std::fs::remove_file(root.join("src/Root.tsx")).unwrap();
    let observation = repo.observe_file_graph().unwrap();
    let discard = candidate(&repo, &[]);
    let history = repo.read_history().unwrap();
    let before = repo.read_manuscript().unwrap();
    let generation = repo.accepted_file_graph().unwrap().unwrap().generation;
    repo.accept_observed_file_graph(&discard, &observation)
        .unwrap();
    let acknowledged = repo.accepted_file_graph().unwrap().unwrap();
    let acknowledged_source = repo.read_source_snapshot().unwrap();
    let acknowledged_finalization = repo.read_finalization().unwrap();
    let name = repo.read().unwrap().unwrap().title;
    repo.accept_observed_file_graph(&discard, &observation)
        .unwrap();
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), acknowledged);
    assert_eq!(repo.read_source_snapshot().unwrap(), acknowledged_source);
    assert_eq!(repo.read_finalization().unwrap(), acknowledged_finalization);
    assert_eq!(repo.read().unwrap().unwrap().title, name);

    assert_graph_physical(&repo, &root);
    assert_eq!(repo.read_manuscript().unwrap(), before);
    assert_eq!(repo.read_history().unwrap(), history);
    assert_eq!(
        repo.accepted_file_graph().unwrap().unwrap().generation,
        generation + 1
    );
    assert!(!root.join("discard/add.bin").exists());
    put(&root, "public/clip.bin", b"first observed");
    let observed = repo.observe_file_graph().unwrap();
    let discard = candidate(&repo, &[]);
    put(&root, "unexpected.bin", b"new after observation");
    assert_eq!(
        repo.accept_observed_file_graph(&discard, &observed)
            .unwrap_err()
            .0,
        "GRAPH_OBSERVATION_STALE"
    );
    assert_eq!(
        repo.command_receipt(&discard.request_id).unwrap_err().0,
        "GRAPH_OBSERVATION_STALE"
    );
    assert_eq!(
        std::fs::read(root.join("unexpected.bin")).unwrap(),
        b"new after observation"
    );
}
#[test]
fn observed_physical_discard_failure_recovers_observed_before_not_accepted_before() {
    for point in ["after-promotion-0", "before-sql", "after-sql"] {
        let (_dir, root, repo) = seed();
        put(&root, "public/clip.bin", b"external");
        std::fs::remove_file(root.join("src/Root.tsx")).unwrap();
        put(&root, "new.bin", b"new");
        let observation = repo.observe_file_graph().unwrap();
        let batch = candidate(&repo, &[]);
        let old = repo.accepted_file_graph().unwrap().unwrap();
        *repo.source_fault.lock().unwrap() = Some(point.into());
        assert!(
            repo.accept_observed_file_graph(&batch, &observation)
                .is_err()
        );
        drop(repo);
        let repo = SqliteProjectRepository::open_format(&root)
            .unwrap_or_else(|e| panic!("{point}: {e:?}"));
        assert_eq!(repo.accepted_file_graph().unwrap().unwrap().hash, old.hash);
        assert_eq!(repo.read_history().unwrap().undo_count, 0);
        if point == "after-sql" {
            assert_graph_physical(&repo, &root);
            assert!(!root.join("new.bin").exists());
        } else {
            assert_eq!(
                std::fs::read(root.join("public/clip.bin")).unwrap(),
                b"external"
            );
            assert!(!root.join("src/Root.tsx").exists());
            assert!(root.join("new.bin").exists());
        }
    }
}
#[test]
fn large_binary_closure_uses_bounded_streams_and_checked_overflow_budgets() {
    use std::io::Write;
    struct Counting {
        size: u64,
        max: usize,
    }
    impl Write for Counting {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.size += bytes.len() as u64;
            self.max = self.max.max(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let (dir, root, repo) = fixture();
    let size = 5 * 1024 * 1024 + 17;
    let mut file = std::fs::File::create(root.join("movie.bin")).unwrap();
    for _ in 0..(size / 4096) {
        file.write_all(&[123; 4096]).unwrap();
    }
    file.write_all(&vec![123; size % 4096]).unwrap();
    drop(file);
    let started = std::time::Instant::now();
    let graph = repo.register_file_graph().unwrap();
    let member = graph.graph.file("movie.bin").unwrap();
    assert_eq!(member.size, size as u64);
    let mut output = Counting { size: 0, max: 0 };
    repo.stream_object_to(&member.hash, &mut output).unwrap();
    assert_eq!(output.size, size as u64);
    assert!(output.max <= 64 * 1024);
    let mut tiny = Counting { size: 0, max: 0 };
    let data = b"a bounded streaming fixture";
    let result = crate::storage::objects::stream_copy_with_buffer(
        &mut data.as_slice(),
        &mut tiny,
        100,
        &mut [0; 3],
    )
    .unwrap();
    assert_eq!(result, (hash(data), data.len() as u64));
    assert_eq!(tiny.max, 3);
    let mut invalid = graph.graph.clone();
    invalid.files = vec![
        GraphFile {
            path: "a".into(),
            hash: "a".repeat(64),
            size: u64::MAX,
        },
        GraphFile {
            path: "b".into(),
            hash: "b".repeat(64),
            size: 1,
        },
    ];
    assert_eq!(
        inventory::validate_members(
            &invalid,
            GraphBudgets {
                files: 2,
                per_file: u64::MAX,
                aggregate: u64::MAX
            }
        )
        .unwrap_err()
        .0,
        "GRAPH_BUDGET_EXCEEDED"
    );
    repo.collect_objects(std::time::Duration::ZERO).unwrap();
    let backup = repo.verified_backup().unwrap();
    let restored_root = dir.path().join("stream-restored");
    let restored = SqliteProjectRepository::restore_verified_copy(&backup, &restored_root).unwrap();
    assert_eq!(
        std::fs::metadata(restored_root.join("movie.bin"))
            .unwrap()
            .len(),
        size as u64
    );
    assert_eq!(
        restored.accepted_file_graph().unwrap().unwrap().hash,
        graph.hash
    );
    drop(restored);
    drop(repo);
    SqliteProjectRepository::open_format(&root).unwrap();
    eprintln!(
        "OP4-A streamed binary {} bytes registration/GC/backup/restore/reopen {:?}; max output chunk {}",
        size,
        started.elapsed(),
        output.max
    );
}
#[test]
fn real_approval_and_downstream_owners_pin_original_graph_beyond_five_transitions() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "Approved text\n"))
        .unwrap();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[],"locked":true,"all":true}),
    );
    let approved = repo.read_finalization().unwrap().baseline.unwrap();
    let captured = repo.accepted_file_graph().unwrap().unwrap();
    let source = repo.read_source_snapshot().unwrap();
    let consumer = id();
    let fence = repo
        .start_downstream_fixture(&consumer, &source.semantic_block_ids)
        .unwrap();
    let blocked = candidate(&repo, &[("public/clip.bin", Some(b"reserved"))]);
    assert_eq!(
        repo.accept_file_graph(&blocked).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    assert_eq!(
        repo.command_receipt(&blocked.request_id).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    assert!(
        repo.finish_downstream_fixture(&consumer, &fence, false)
            .unwrap()
    );
    for n in 0..7 {
        repo.accept_file_graph(&candidate(
            &repo,
            &[("public/clip.bin", Some(format!("media {n}").as_bytes()))],
        ))
        .unwrap();
    }
    {
        let c = repo.connection.lock().unwrap();
        let pin: (String, String) = c
            .query_row(
                "SELECT graph_hash,capture_kind FROM approved_file_graphs WHERE baseline_id=?1",
                [&approved.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(pin, (captured.hash.clone(), "approval".into()));
        let pin: String = c
            .query_row(
                "SELECT graph_hash FROM file_graph_pins WHERE owner_id=?1",
                [format!("downstream:{consumer}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pin, captured.hash);
    }
    repo.collect_objects(std::time::Duration::ZERO).unwrap();
    assert!(
        repo.retained_object_roots()
            .unwrap()
            .contains(&captured.graph.file("public/clip.bin").unwrap().hash)
    );
    assert_eq!(repo.read_source_snapshot().unwrap().source, source.source);
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(
        repo.read_finalization()
            .unwrap()
            .baseline
            .unwrap()
            .manifest_hash,
        approved.manifest_hash
    );
}
#[test]
fn registration_provenance_never_relabels_an_older_approved_source() {
    let (_dir, _root, repo) = fixture();
    repo.save_source(&request(&repo, "Older approved text\n"))
        .unwrap();
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":[],"locked":true,"all":true}),
    );
    let approved = repo.read_finalization().unwrap().baseline.unwrap();
    let old = repo.read_source_snapshot().unwrap().accepted_hash;
    command(
        &repo,
        "SetUserLocks",
        serde_json::json!({"blockIds":repo.read_source_snapshot().unwrap().semantic_block_ids,"locked":false,"all":false}),
    );
    repo.save_source(&request(&repo, "Newer current text\n"))
        .unwrap();
    let graph = repo.register_file_graph().unwrap();
    let c = repo.connection.lock().unwrap();
    let pin: (String, String) = c
        .query_row(
            "SELECT graph_hash,capture_kind FROM approved_file_graphs WHERE baseline_id=?1",
            [&approved.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(pin, (graph.hash, "registration".into()));
    let raw: crate::finalization::ApprovedManifest =
        serde_json::from_slice(&repo.read_object(&approved.manifest_hash).unwrap()).unwrap();
    assert_eq!(raw.source_hash, Some(old));
    assert_ne!(
        raw.source_hash.as_ref(),
        Some(&graph.graph.file("manuscript.md").unwrap().hash)
    );
}
#[test]
fn graph_name_authority_external_manifest_and_rename_aba_replay() {
    let (_dir, root, repo) = fixture();
    let project = repo.read().unwrap().unwrap();
    repo.rename(
        "before-registration",
        &project.id,
        "Untitled project",
        "Existing SQL title",
    )
    .unwrap();
    assert_eq!(
        repo.register_file_graph().unwrap_err().0,
        "GRAPH_NAME_MISMATCH"
    );
    let path = root.join("project.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["name"] = "Existing SQL title".into();
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    repo.register_file_graph().unwrap();
    repo.rename(
        "graph-rename",
        &project.id,
        "Existing SQL title",
        "Normal rename",
    )
    .unwrap();
    let old = repo.read_history().unwrap();
    repo.rename("noop-rename", &project.id, "Normal rename", "Normal rename")
        .unwrap();
    assert_eq!(repo.read_history().unwrap(), old);
    for title in ["External name", "Normal rename"] {
        manifest["name"] = title.into();
        std::fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
        let observed = repo.observe_file_graph().unwrap();
        let mut batch = candidate(&repo, &[]);
        batch.candidate_hash = observed.graph_hash().into();
        repo.accept_observed_file_graph(&batch, &observed).unwrap();
        assert_eq!(repo.read().unwrap().unwrap().title, title);
    }
    assert!(matches!(
        repo.rename("noop-rename", &project.id, "Normal rename", "Normal rename"),
        Err(Error::Conflict)
    ));
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read().unwrap().unwrap().title, "External name");
    assert_graph_physical(&repo, &root);
}
#[test]
fn old_history_changes_only_manuscript_and_five_graph_transitions_reopen_in_middle() {
    let (_dir, root, repo) = fixture();
    repo.save_source(&request(&repo, "Older source\n")).unwrap();
    repo.register_file_graph().unwrap();
    repo.rename(
        "first-name",
        &repo.read().unwrap().unwrap().id,
        "Untitled project",
        "Current name",
    )
    .unwrap();
    command(&repo, "UndoProject", serde_json::json!({}));
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, "");
    command(&repo, "RedoProject", serde_json::json!({}));
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(repo.read().unwrap().unwrap().title, "Current name");
    for n in 0..7 {
        repo.accept_file_graph(&candidate(&repo, &[("media.bin", Some(&[n]))]))
            .unwrap();
    }
    for _ in 0..3 {
        command(&repo, "UndoProject", serde_json::json!({}));
    }
    assert_eq!(repo.read_history().unwrap().redo_count, 3);
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    for _ in 0..3 {
        command(&repo, "RedoProject", serde_json::json!({}));
    }
    for _ in 0..5 {
        command(&repo, "UndoProject", serde_json::json!({}));
    }
    assert_eq!(std::fs::read(root.join("media.bin")).unwrap(), [1]);
    assert_eq!(repo.read_history().unwrap().undo_count, 0);
    assert_eq!(repo.read().unwrap().unwrap().title, "Current name");
    assert_graph_physical(&repo, &root);
}
#[test]
fn sql_failure_recovers_and_definite_graph_rejections_replay_after_later_changes() {
    let (_dir, root, repo) = seed();
    let before = repo.accepted_file_graph().unwrap().unwrap();
    let batch = candidate(&repo, &[("public/clip.bin", Some(b"new bytes"))]);
    {
        let c = repo.connection.lock().unwrap();
        c.execute_batch("CREATE TEMP TRIGGER fail_graph_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
    }
    assert_eq!(
        repo.accept_file_graph(&batch).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), before);
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"new bytes"
    );
    repo.recover_source_intents().unwrap();
    assert_graph_physical(&repo, &root);
    repo.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_graph_receipt")
        .unwrap();
    repo.accept_file_graph(&batch).unwrap();
    let invalid = candidate(&repo, &[("manuscript.md", None)]);
    assert_eq!(
        repo.accept_file_graph(&invalid).unwrap_err().0,
        "GRAPH_REQUIRED_FILE_MISSING"
    );
    assert_eq!(
        repo.command_receipt(&invalid.request_id).unwrap_err().0,
        "GRAPH_REQUIRED_FILE_MISSING"
    );
    repo.accept_file_graph(&candidate(&repo, &[("public/clip.bin", Some(b"later"))]))
        .unwrap();
    assert_eq!(
        repo.accept_file_graph(&invalid).unwrap_err().0,
        "GRAPH_REQUIRED_FILE_MISSING"
    );
    let noop = candidate(&repo, &[]);
    let current = repo.accepted_file_graph().unwrap().unwrap();
    let history = repo.read_history().unwrap();
    let receipt = repo.accept_file_graph(&noop).unwrap();
    assert_eq!(repo.accept_file_graph(&noop).unwrap(), receipt);
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), current);
    assert_eq!(repo.read_history().unwrap(), history);
}
#[test]
fn native_promotion_races_preserve_new_additions_displaced_replacements_and_changed_ancestors() {
    for scenario in ["addition", "replacement", "ancestor"] {
        let (_dir, root, repo) = seed();
        let path = if scenario == "addition" {
            "new.bin"
        } else {
            "public/clip.bin"
        };
        let batch = candidate(&repo, &[(path, Some(b"candidate"))]);
        let race = root.clone();
        *repo.source_action.lock().unwrap() = Some((
            "before-promotion-0".into(),
            Box::new(move || match scenario {
                "addition" => put(&race, "new.bin", b"third-party"),
                "replacement" => {
                    std::fs::rename(race.join("public/clip.bin"), race.join("original.bin"))
                        .unwrap();
                    put(&race, "public/clip.bin", b"third-party");
                }
                _ => {
                    std::fs::rename(race.join("public"), race.join("displaced-public")).unwrap();
                    put(&race, "public/clip.bin", b"third-party");
                }
            }),
        ));
        assert!(repo.accept_file_graph(&batch).is_err());
        assert_eq!(
            repo.accepted_file_graph().unwrap().unwrap().hash,
            batch.base_hash
        );
        if scenario == "addition" {
            assert_eq!(std::fs::read(root.join("new.bin")).unwrap(), b"third-party");
        } else if scenario == "ancestor" {
            assert_eq!(
                std::fs::read(root.join("public/clip.bin")).unwrap(),
                b"third-party"
            );
        } else {
            let versions = std::fs::read_dir(root.join("public"))
                .unwrap()
                .map(|e| std::fs::read(e.unwrap().path()).unwrap())
                .collect::<Vec<_>>();
            assert!(versions.contains(&b"third-party".to_vec()));
        }
    }
}
#[test]
fn file_directory_topology_refuses_both_directions_and_live_accept_before_history() {
    for reverse in [false, true] {
        let (_dir, root, repo) = seed();
        let initial = candidate(
            &repo,
            &[(
                if reverse { "tree/child.bin" } else { "tree" },
                Some(b"original"),
            )],
        );
        repo.accept_file_graph(&initial).unwrap();
        let old = repo.accepted_file_graph().unwrap().unwrap();
        let history = repo.read_history().unwrap();
        let batch = if reverse {
            candidate(
                &repo,
                &[("tree/child.bin", None), ("tree", Some(b"replacement"))],
            )
        } else {
            candidate(
                &repo,
                &[("tree", None), ("tree/child.bin", Some(b"replacement"))],
            )
        };
        assert_eq!(
            repo.accept_file_graph(&batch).unwrap_err().0,
            "GRAPH_TOPOLOGY_UNSUPPORTED"
        );
        assert_eq!(
            repo.command_receipt(&batch.request_id).unwrap_err().0,
            "GRAPH_TOPOLOGY_UNSUPPORTED"
        );
        assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), old);
        assert_eq!(repo.read_history().unwrap(), history);
        assert_graph_physical(&repo, &root);
        assert!(!repo.intent_path().exists());
        if reverse {
            std::fs::remove_file(root.join("tree/child.bin")).unwrap();
            std::fs::remove_dir(root.join("tree")).unwrap();
            put(&root, "tree", b"live");
        } else {
            std::fs::remove_file(root.join("tree")).unwrap();
            put(&root, "tree/child.bin", b"live");
        }
        let observed = repo.observe_file_graph().unwrap();
        let mut accept = candidate(&repo, &[]);
        accept.candidate_hash = observed.graph_hash().into();
        assert_eq!(
            repo.accept_observed_file_graph(&accept, &observed)
                .unwrap_err()
                .0,
            "GRAPH_TOPOLOGY_UNSUPPORTED"
        );
        assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), old);
        assert_eq!(repo.read_history().unwrap(), history);
        assert!(!repo.file_graph_capabilities().file_directory_transitions);
        let discard = candidate(&repo, &[]);
        assert_eq!(
            repo.accept_observed_file_graph(&discard, &observed)
                .unwrap_err()
                .0,
            "GRAPH_TOPOLOGY_UNSUPPORTED"
        );
        assert_eq!(
            repo.accept_observed_file_graph(&discard, &observed)
                .unwrap_err()
                .0,
            "GRAPH_TOPOLOGY_UNSUPPORTED"
        );
    }
}
#[test]
fn observed_recovery_stale_choice_cannot_settle_a_newer_intent_or_changed_inventory() {
    let (_dir, root, repo) = seed();
    let batch = candidate(&repo, &[("public/clip.bin", Some(b"first"))]);
    *repo.source_fault.lock().unwrap() = Some("after-promotion-0".into());
    assert!(repo.accept_file_graph(&batch).is_err());
    put(&root, "public/twin.bin", b"unrelated external");
    let intent_hash = hash(&std::fs::read(repo.intent_path()).unwrap());
    let mut recovery = AuthoredSourceRecoverRequest {
        project_id: batch.project_id.clone(),
        request_id: batch.request_id.clone(),
        intent_hash: intent_hash.clone(),
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: Some(repo.graph_recovery_fingerprint(&intent_hash).unwrap()),
    };
    put(&root, "untracked.bin", b"changed after choice");
    assert_eq!(
        repo.recover_source(&recovery).unwrap_err().0,
        "SOURCE_RECOVERY_STALE"
    );
    recovery.observation_fingerprint = Some(repo.graph_recovery_fingerprint(&intent_hash).unwrap());
    repo.recover_source(&recovery).unwrap();
    let evidence = repo.graph_recovery_members(&intent_hash, 0, 200).unwrap();
    assert!(
        evidence
            .iter()
            .any(|m| m.path == "untracked.bin" && m.role == "live")
    );
    assert!(evidence.iter().any(|m| m.path == "public/twin.bin"
        && m.role == "live"
        && m.hash == hash(b"unrelated external")));
    let observation = repo.observe_file_graph().unwrap();
    repo.accept_observed_file_graph(&candidate(&repo, &[]), &observation)
        .unwrap();
    let next = candidate(&repo, &[("public/clip.bin", Some(b"second"))]);
    *repo.source_fault.lock().unwrap() = Some("after-intent".into());
    assert!(repo.accept_file_graph(&next).is_err());
    let pending = std::fs::read(repo.intent_path()).unwrap();
    repo.recover_source(&recovery).unwrap();
    assert_eq!(std::fs::read(repo.intent_path()).unwrap(), pending);
    assert_ne!(hash(&pending), intent_hash);
}
#[test]
fn source_name_and_source_history_do_not_read_unchanged_large_binary() {
    use std::io::Write;
    let (_dir, root, repo) = fixture();
    let mut file = File::create(root.join("large.bin")).unwrap();
    for _ in 0..1280 {
        file.write_all(&[17; 4096]).unwrap();
    }
    drop(file);
    repo.register_file_graph().unwrap();
    let media = repo
        .accepted_file_graph()
        .unwrap()
        .unwrap()
        .graph
        .file("large.bin")
        .unwrap()
        .hash
        .clone();
    let clear = || crate::storage::objects::STREAMED.with(|reads| reads.borrow_mut().clear());
    let count = || {
        crate::storage::objects::STREAMED.with(|reads| *reads.borrow().get(&media).unwrap_or(&0))
    };
    clear();
    let started = std::time::Instant::now();
    repo.save_source(&request(&repo, "Small source\n")).unwrap();
    assert_eq!(count(), 0);
    repo.rename(
        "small-name",
        &repo.read().unwrap().unwrap().id,
        "Untitled project",
        "Name only",
    )
    .unwrap();
    assert_eq!(count(), 0);
    command(&repo, "UndoProject", serde_json::json!({}));
    command(&repo, "UndoProject", serde_json::json!({}));
    command(&repo, "RedoProject", serde_json::json!({}));
    assert_eq!(count(), 0);
    eprintln!(
        "OP4-A source/name/three history operations {:?}; unchanged media bytes read {}",
        started.elapsed(),
        count()
    );
    repo.inventory_file_graph(&root, false, GraphBudgets::default())
        .unwrap();
    assert!(count() > 0);
    clear();
    repo.accept_file_graph(&candidate(&repo, &[("new.bin", Some(b"full batch"))]))
        .unwrap();
    assert!(count() > 0);
    eprintln!(
        "OP4-A explicit full batch read unchanged media bytes {}",
        count()
    );
}
#[test]
fn scoped_source_preserves_pending_media_and_manifest_while_backup_uses_accepted_graph() {
    let (dir, root, repo) = seed();
    repo.save_source(&request(&repo, "Before\n")).unwrap();
    let baseline = repo.accepted_file_graph().unwrap().unwrap();
    put(&root, "public/clip.bin", b"unaccepted live media");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("project.json")).unwrap()).unwrap();
    manifest["name"] = "Pending external name".into();
    manifest["video"] = serde_json::json!({"entry":"src/Root.tsx","compositionId":"Pending"});
    put(
        &root,
        "project.json",
        &serde_json::to_vec_pretty(&manifest).unwrap(),
    );
    repo.save_source(&request(
        &repo,
        &repo
            .read_source_snapshot()
            .unwrap()
            .source
            .replace("Before", "Latest saved"),
    ))
    .unwrap();
    let current = repo.accepted_file_graph().unwrap().unwrap();
    assert_eq!(
        current.graph.file("public/clip.bin").unwrap(),
        baseline.graph.file("public/clip.bin").unwrap()
    );
    assert_eq!(
        current.graph.file("project.json").unwrap(),
        baseline.graph.file("project.json").unwrap()
    );
    assert_eq!(repo.read().unwrap().unwrap().title, "Untitled project");
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"unaccepted live media"
    );
    assert!(
        repo.rename(
            "pending-manifest",
            &current.graph.project_id,
            "Untitled project",
            "App rename"
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"unaccepted live media"
    );
    let backup = repo.verified_backup().unwrap();
    let restored_root = dir.path().join("accepted-backup");
    let restored = SqliteProjectRepository::restore_verified_copy(&backup, &restored_root).unwrap();
    assert_graph_physical(&restored, &restored_root);
    assert_eq!(
        std::fs::read(restored_root.join("public/clip.bin")).unwrap(),
        [0, 255, 1, 128]
    );
    assert!(
        restored
            .read_source_snapshot()
            .unwrap()
            .source
            .contains("Latest saved")
    );
    assert_eq!(restored.read().unwrap().unwrap().title, "Untitled project");
    manifest["projectId"] = id().into();
    put(
        &root,
        "project.json",
        &serde_json::to_vec(&manifest).unwrap(),
    );
    let req = request(
        &repo,
        &repo
            .read_source_snapshot()
            .unwrap()
            .source
            .replace("Latest", "Tampered"),
    );
    assert_eq!(
        repo.save_source(&req).unwrap_err().0,
        "SOURCE_PROJECT_MISMATCH"
    );
    assert_eq!(
        repo.command_receipt(&req.request_id).unwrap_err().0,
        "SOURCE_PROJECT_MISMATCH"
    );
    assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), current);
}
#[test]
fn scoped_recovery_ignores_unrelated_external_media_and_validates_scope_tampering() {
    let (_dir, root, repo) = seed();
    let source = request(&repo, "Scoped source\n");
    *repo.source_fault.lock().unwrap() = Some("after-promotion-0".into());
    assert!(repo.save_source(&source).is_err());
    put(&root, "public/clip.bin", b"unrelated pending");
    let original = std::fs::read(repo.intent_path()).unwrap();
    let mut intent: Intent = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        intent.graph.as_ref().unwrap().checked_paths,
        Some(vec!["manuscript.md".into()])
    );
    intent.graph.as_mut().unwrap().checked_paths =
        Some(vec!["manuscript.md".into(), "public/clip.bin".into()]);
    std::fs::write(repo.intent_path(), serde_json::to_vec(&intent).unwrap()).unwrap();
    assert_eq!(
        repo.recover_source_intents().unwrap_err().0,
        "SOURCE_RECOVERY_REQUIRED"
    );
    std::fs::write(repo.intent_path(), original).unwrap();
    repo.recover_source_intents().unwrap();
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"unrelated pending"
    );
    assert_eq!(repo.read_source_snapshot().unwrap().source, "");
    repo.save_source(&source).unwrap();
    assert_eq!(
        std::fs::read(root.join("public/clip.bin")).unwrap(),
        b"unrelated pending"
    );
}
#[test]
fn native_candidate_preparation_preserves_original_ids_and_binds_new_paragraph_once() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "Original paragraph\n"))
        .unwrap();
    let original = repo.read_source_snapshot().unwrap();
    let raw = format!("{}\nNew external paragraph\n", original.source);
    let mut batch = candidate(&repo, &[("manuscript.md", Some(raw.as_bytes()))]);
    let history = repo.read_history().unwrap();
    let prepared = repo
        .prepare_file_graph_candidate(&batch.candidate_hash)
        .unwrap();
    assert_eq!(prepared.original_hash, batch.candidate_hash);
    assert_eq!(prepared.assigned.len(), 1);
    assert_eq!(repo.read_history().unwrap(), history);
    assert_eq!(
        std::fs::read(root.join("manuscript.md")).unwrap(),
        original.source.as_bytes()
    );
    let graph = repo.read_file_graph(&prepared.prepared_hash).unwrap();
    let bound = String::from_utf8(
        repo.read_object(&graph.file("manuscript.md").unwrap().hash)
            .unwrap(),
    )
    .unwrap();
    assert!(bound.starts_with(&original.source));
    assert!(bound.contains(&prepared.assigned[0].id));
    let document = source::read_source(bound.as_bytes(), &[]).unwrap();
    assert!(
        document
            .blocks
            .iter()
            .any(|b| b.id.as_ref() == Some(&original.semantic_block_ids[0]))
    );
    batch.candidate_hash = prepared.prepared_hash;
    repo.accept_file_graph(&batch).unwrap();
    assert_graph_physical(&repo, &root);
    let same = repo
        .prepare_file_graph_candidate(&batch.candidate_hash)
        .unwrap();
    assert_eq!(same.prepared_hash, batch.candidate_hash);
    assert!(same.assigned.is_empty());
    let invalid = format!(
        "Same <!-- scenesparrow:block={} -->\n\nDuplicate <!-- scenesparrow:block={} -->\n",
        original.semantic_block_ids[0], original.semantic_block_ids[0]
    );
    let bad = candidate(&repo, &[("manuscript.md", Some(invalid.as_bytes()))]);
    assert_eq!(
        repo.prepare_file_graph_candidate(&bad.candidate_hash)
            .unwrap_err()
            .0,
        "IDENTITY_DUPLICATE"
    );
}
#[test]
fn live_candidate_preparation_binds_inspected_original_physical_before() {
    let (_dir, root, repo) = seed();
    repo.save_source(&request(&repo, "Accepted\n")).unwrap();
    let before = repo.read_source_snapshot().unwrap();
    let raw = format!("{}\nRaw live new paragraph\n", before.source);
    put(&root, "manuscript.md", raw.as_bytes());
    let observed = repo.observe_file_graph().unwrap();
    let prepared = repo
        .prepare_file_graph_candidate(observed.graph_hash())
        .unwrap();
    let mut batch = candidate(&repo, &[]);
    batch.candidate_hash = prepared.prepared_hash;
    let receipt = repo.accept_observed_file_graph(&batch, &observed).unwrap();
    assert_eq!(
        repo.accept_observed_file_graph(&batch, &observed).unwrap(),
        receipt
    );
    assert_graph_physical(&repo, &root);
    let after = repo.read_source_snapshot().unwrap();
    assert_eq!(after.semantic_block_ids.len(), 2);
    assert!(after.source.starts_with(&before.source));
    assert!(after.source.contains(&prepared.assigned[0].id));
    command(&repo, "UndoProject", serde_json::json!({}));
    assert_eq!(repo.read_source_snapshot().unwrap().source, before.source);
}
#[test]
fn graph_closure_and_sidecar_corruption_refuse_verification_without_repair() {
    for mode in ["current-object", "history-sidecar"] {
        let (_dir, root, repo) = seed();
        repo.accept_file_graph(&candidate(&repo, &[("public/clip.bin", Some(b"updated"))]))
            .unwrap();
        let graph = repo.accepted_file_graph().unwrap().unwrap();
        if mode == "current-object" {
            std::fs::write(
                repo.directory
                    .join("objects")
                    .join(&graph.graph.file("public/clip.bin").unwrap().hash),
                b"corrupt",
            )
            .unwrap();
            assert!(repo.collect_objects(Duration::ZERO).is_err());
            assert!(repo.verified_backup().is_err());
        } else {
            let c = repo.connection.lock().unwrap();
            c.execute("UPDATE history_file_graphs SET after_hash=before_hash", [])
                .unwrap();
            assert!(repo.verify_file_graph_history(&c).is_err());
        }
        drop(repo);
        assert!(SqliteProjectRepository::open_format(&root).is_err());
    }
}
#[test]
fn unknown_binary_stage_during_cleanup_is_retained_and_old_base64_api_refuses_v3() {
    let (_dir, root, repo) = seed();
    let batch = candidate(
        &repo,
        &[
            ("public/clip.bin", Some(b"first")),
            ("public/twin.bin", Some(b"second")),
        ],
    );
    let captured = root.clone();
    *repo.source_action.lock().unwrap() = Some((
        "after-cleanup-0".into(),
        Box::new(move || {
            for entry in std::fs::read_dir(captured.join("public")).unwrap() {
                let entry = entry.unwrap();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".scenesparrow-stage-")
                {
                    std::fs::write(entry.path(), [0, 255, 4, 128]).unwrap();
                }
            }
        }),
    ));
    assert_eq!(
        repo.accept_file_graph(&batch).unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    let hash = hash(&std::fs::read(repo.intent_path()).unwrap());
    assert_eq!(
        repo.source_recovery_evidence(&hash).unwrap_err().0,
        "SOURCE_CAPABILITY_UNSUPPORTED"
    );
    assert_eq!(
        repo.recover_source_intents().unwrap_err().0,
        "SOURCE_EXTERNAL_CHANGE"
    );
    let request = AuthoredSourceRecoverRequest {
        project_id: batch.project_id.clone(),
        request_id: batch.request_id.clone(),
        intent_hash: hash.clone(),
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: Some(repo.graph_recovery_fingerprint(&hash).unwrap()),
    };
    repo.recover_source(&request).unwrap();
    let mut bytes = vec![];
    repo.stream_graph_recovery_member(
        &hash,
        "public/twin.bin",
        "staged",
        &crate::storage::hash(&[0, 255, 4, 128]),
        &mut bytes,
    )
    .unwrap();
    assert_eq!(bytes, [0, 255, 4, 128]);
    repo.collect_objects(Duration::ZERO).unwrap();
    drop(repo);
    let repo = SqliteProjectRepository::open_format(&root).unwrap();
    assert_eq!(repo.accept_file_graph(&batch).unwrap().working_revision, 1);
    assert!(
        !repo
            .graph_recovery_members(&hash, 0, 200)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn missing_or_unparseable_manifest_fences_source_and_replays_original_rejection() {
    let (_dir, root, repo) = seed();
    let before = repo.accepted_file_graph().unwrap().unwrap();
    for (bytes, code) in [
        (None, "SOURCE_READ_UNAVAILABLE"),
        (Some(b"{".as_slice()), "FORMAT_INVALID"),
    ] {
        if let Some(bytes) = bytes {
            put(&root, "project.json", bytes);
        } else {
            std::fs::remove_file(root.join("project.json")).unwrap();
        }
        let request = request(&repo, "Preserve required manifest\n");
        assert_eq!(repo.save_source(&request).unwrap_err().0, code);
        assert_eq!(
            repo.command_receipt(&request.request_id).unwrap_err().0,
            code
        );
        assert_eq!(repo.save_source(&request).unwrap_err().0, code);
        assert_eq!(repo.accepted_file_graph().unwrap().unwrap(), before);
    }
}

#[test]
fn recovery_stream_roundtrips_each_recorded_path_role_version() {
    let (_dir, root, repo) = seed();
    let batch = candidate(&repo, &[("public/clip.bin", Some(b"proposed"))]);
    *repo.source_fault.lock().unwrap() = Some("after-promotion-0".into());
    assert!(repo.accept_file_graph(&batch).is_err());
    put(&root, "public/clip.bin", b"first retained live version");
    let intent_hash = hash(&std::fs::read(repo.intent_path()).unwrap());
    repo.recover_source(&AuthoredSourceRecoverRequest {
        project_id: batch.project_id,
        request_id: batch.request_id,
        intent_hash: intent_hash.clone(),
        disposition: Some(AuthoredSourceRecoverRequestDisposition::PreserveExternal),
        observation_fingerprint: Some(repo.graph_recovery_fingerprint(&intent_hash).unwrap()),
    })
    .unwrap();
    // Capture can retain two live versions around an ABA observation. Both are
    // valid members of the same operation; the recorded hash distinguishes them.
    let second = b"second retained live version";
    let second_hash = repo.object(second).unwrap();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO graph_recovery_members VALUES(?1,?2,'live',?3,?4)",
            params![
                intent_hash,
                "public/clip.bin",
                second_hash,
                second.len() as u64
            ],
        )
        .unwrap();
    let members = repo.graph_recovery_members(&intent_hash, 0, 200).unwrap();
    let versions = members
        .iter()
        .filter(|member| member.path == "public/clip.bin" && member.role == "live")
        .collect::<Vec<_>>();
    assert_eq!(versions.len(), 2);
    for member in versions {
        let mut bytes = vec![];
        repo.stream_graph_recovery_member(
            &intent_hash,
            &member.path,
            &member.role,
            &member.hash,
            &mut bytes,
        )
        .unwrap();
        assert_eq!(
            hash(&bytes),
            member.hash,
            "each listed version must be retrievable"
        );
        assert_eq!(bytes.len() as u64, member.size);
    }
    for member in members.iter().filter(|member| {
        member.role == "acceptedBefore"
            && ["public/clip.bin", "public/twin.bin"].contains(&member.path.as_str())
    }) {
        let mut bytes = vec![];
        repo.stream_graph_recovery_member(
            &intent_hash,
            &member.path,
            &member.role,
            &member.hash,
            &mut bytes,
        )
        .unwrap();
        assert_eq!(bytes, [0, 255, 1, 128]);
    }
    for (intent, path, role, digest) in [
        (
            "foreign-intent",
            "public/clip.bin",
            "live",
            second_hash.as_str(),
        ),
        (
            intent_hash.as_str(),
            "public/not-a-member.bin",
            "live",
            second_hash.as_str(),
        ),
        (
            intent_hash.as_str(),
            "public/clip.bin",
            "foreign-role",
            second_hash.as_str(),
        ),
        (
            intent_hash.as_str(),
            "public/twin.bin",
            "live",
            second_hash.as_str(),
        ),
        (
            intent_hash.as_str(),
            "public/clip.bin",
            "live",
            "unrecorded-hash",
        ),
    ] {
        let mut bytes = vec![];
        assert_eq!(
            repo.stream_graph_recovery_member(intent, path, role, digest, &mut bytes)
                .unwrap_err()
                .0,
            "OBJECT_NOT_FOUND"
        );
        assert!(bytes.is_empty());
    }
}
#[test]
fn history_graphs_and_actual_approval_pins_verify_project_and_recorded_source() {
    for mode in ["foreign-history", "historical-source", "approval-source"] {
        let (_dir, root, repo) = seed();
        repo.save_source(&request(&repo, "First\n")).unwrap();
        if mode == "approval-source" {
            command(
                &repo,
                "SetUserLocks",
                serde_json::json!({"blockIds":[],"locked":true,"all":true}),
            );
            let ids = repo.read_source_snapshot().unwrap().semantic_block_ids;
            command(
                &repo,
                "SetUserLocks",
                serde_json::json!({"blockIds":ids,"locked":false,"all":false}),
            );
        }
        repo.save_source(&request(
            &repo,
            &repo
                .read_source_snapshot()
                .unwrap()
                .source
                .replace("First", "Second"),
        ))
        .unwrap();
        let current = repo.accepted_file_graph().unwrap().unwrap();
        let replacement = if mode == "foreign-history" {
            let mut foreign = current.graph.clone();
            foreign.project_id = id();
            repo.object(&serde_json::to_vec(&foreign).unwrap()).unwrap()
        } else {
            current.hash
        };
        {
            let c = repo.connection.lock().unwrap();
            if mode == "approval-source" {
                c.execute(
                    "UPDATE approved_file_graphs SET graph_hash=?1",
                    [replacement],
                )
                .unwrap();
            } else {
                c.execute("UPDATE history_file_graphs SET before_hash=?1 WHERE entry_id=(SELECT entry_id FROM history_entry_identities ORDER BY position LIMIT 1)",[replacement]).unwrap();
            }
            assert!(repo.verify_file_graph_history(&c).is_err());
        }
        assert!(repo.collect_objects(Duration::ZERO).is_err());
        assert!(repo.verified_backup().is_err());
        drop(repo);
        assert!(SqliteProjectRepository::open_format(&root).is_err());
    }
}
#[test]
fn malformed_candidate_control_documents_have_definite_replayable_rejections() {
    let (_dir, root, repo) = seed();
    for bytes in [b"{".as_slice(), &[0xff, 0x80]] {
        let invalid = candidate(&repo, &[("project.json", Some(bytes))]);
        assert_eq!(
            repo.accept_file_graph(&invalid).unwrap_err().0,
            "FORMAT_INVALID"
        );
        assert_eq!(
            repo.command_receipt(&invalid.request_id).unwrap_err().0,
            "FORMAT_INVALID"
        );
        repo.accept_file_graph(&candidate(&repo, &[("later.bin", Some(bytes))]))
            .unwrap();
        assert_eq!(
            repo.accept_file_graph(&invalid).unwrap_err().0,
            "FORMAT_INVALID"
        );
        assert!(!repo.intent_path().exists());
    }
    let graph = repo.accepted_file_graph().unwrap().unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(
        &repo
            .read_object(&graph.graph.file("project.json").unwrap().hash)
            .unwrap(),
    )
    .unwrap();
    manifest["audio"] = serde_json::json!({"plan":"audio/plan.json"});
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let invalid = candidate(
        &repo,
        &[
            ("project.json", Some(&manifest)),
            ("audio/plan.json", Some(b"{")),
        ],
    );
    assert_eq!(
        repo.accept_file_graph(&invalid).unwrap_err().0,
        "FORMAT_INVALID"
    );
    assert_eq!(
        repo.command_receipt(&invalid.request_id).unwrap_err().0,
        "FORMAT_INVALID"
    );
    assert_eq!(
        repo.accept_file_graph(&invalid).unwrap_err().0,
        "FORMAT_INVALID"
    );
    assert_graph_physical(&repo, &root);
}
