use super::*;
use scenesparrow_application::manuscript::ManuscriptRepository;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{ManuscriptError, MutationPolicy},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn command(project: &str, revision: i64, operations: Value, revisions: Value) -> ManuscriptCommand {
    serde_json::from_value(json!({"type":"ApplyDocumentEdit","requestId":id(),"projectId":project,"expectedWorkingRevision":revision,"payload":{"operations":operations,"expectedBlockRevisions":revisions,"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}})).unwrap()
}
fn block(id: &str, text: &str) -> Value {
    json!({"id":id,"kind":"paragraph","attrs":{},"runs":[{"text":text,"marks":[]}]})
}
fn setup() -> (tempfile::TempDir, SqliteProjectRepository, String) {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    let project = repo.create("create", "Manuscript").unwrap();
    let start:ManuscriptCommand=serde_json::from_value(json!({"type":"StartManualDraft","requestId":id(),"projectId":project.id,"expectedWorkingRevision":0,"payload":{}})).unwrap();
    assert_eq!(repo.execute_manuscript(&start).unwrap().working_revision, 1);
    (dir, repo, project.id)
}
#[test]
fn first_edit_is_one_atomic_replayable_history_entry_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    let project = repo.create("create", "Direct writing").unwrap().id;
    let empty = repo.read_manuscript().unwrap();
    for operations in [json!([]), {
        let temporary = id();
        json!([{"op":"insertBlock","block":block(&temporary,"temporary"),"after":null},{"op":"deleteBlock","id":temporary}])
    }] {
        let receipt = repo
            .execute_manuscript(&command(&project, 0, operations, json!([])))
            .unwrap();
        assert_eq!(receipt.working_revision, 0);
        assert_eq!(receipt.undo_count, 0);
        assert_eq!(repo.read_manuscript().unwrap(), empty);
    }
    let invalid = command(
        &project,
        0,
        json!([{"op":"insertBlock","block":block(&id(),"invalid\u{0}"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&invalid).unwrap_err().0,
        "DOCUMENT_INVALID"
    );
    assert_eq!(repo.read_manuscript().unwrap(), empty);
    let first = id();
    let edit = command(
        &project,
        0,
        json!([{"op":"insertBlock","block":block(&first,"First 🐦"),"after":null}]),
        json!([]),
    );
    let receipt = repo.execute_manuscript(&edit).unwrap();
    assert_eq!(receipt.working_revision, 1);
    assert_eq!(receipt.undo_count, 1);
    assert_eq!(repo.execute_manuscript(&edit).unwrap(), receipt);
    assert_eq!(repo.command_receipt(&receipt.request_id).unwrap(), receipt);
    let saved = repo.read_manuscript().unwrap();
    assert_eq!(saved.workspace_stage, ManuscriptStateWorkspaceStage::Draft);
    assert_eq!(saved.blocks[0].id, first);
    let stale = command(
        &project,
        0,
        json!([{"op":"insertBlock","block":block(&id(),"Other writer"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&stale).unwrap_err().0,
        "REVISION_CONFLICT"
    );
    drop(repo);
    let mut repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read_manuscript().unwrap(), saved);
    for (name, stage) in [
        ("UndoProject", ManuscriptStateWorkspaceStage::Outline),
        ("RedoProject", ManuscriptStateWorkspaceStage::Draft),
    ] {
        let h = repo.read_history().unwrap();
        let command = serde_json::from_value(json!({"type":name,"requestId":id(),"projectId":project,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap();
        let receipt = repo.execute_manuscript(&command).unwrap();
        assert!(receipt.working_revision > h.working_revision);
        let state = repo.read_manuscript().unwrap();
        assert_eq!(state.workspace_stage, stage);
        if name == "UndoProject" {
            assert!(state.blocks.is_empty());
        } else {
            assert_eq!(state.blocks[0].id, first);
            assert!(state.blocks[0].revision > saved.blocks[0].revision);
        }
        drop(repo);
        repo = SqliteProjectRepository::open(dir.path()).unwrap();
        assert_eq!(repo.read_manuscript().unwrap(), state);
    }
    let restored = repo.read_manuscript().unwrap();
    drop(repo);
    assert_eq!(
        SqliteProjectRepository::open(dir.path())
            .unwrap()
            .read_manuscript()
            .unwrap(),
        restored
    );
}

#[test]
fn concurrent_first_edits_commit_one_body_and_one_history_entry() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let repo = Arc::new(SqliteProjectRepository::open(dir.path()).unwrap());
    let project = repo.create("create", "Concurrent entry").unwrap().id;
    let barrier = Arc::new(Barrier::new(2));
    let writers = (0..2)
        .map(|_| {
            let repo = repo.clone();
            let barrier = barrier.clone();
            let edit = command(
                &project,
                0,
                json!([{"op":"insertBlock","block":block(&id(),"First"),"after":null}]),
                json!([]),
            );
            std::thread::spawn(move || {
                barrier.wait();
                repo.execute_manuscript(&edit)
            })
        })
        .collect::<Vec<_>>();
    let outcomes = writers
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        outcomes.iter().find_map(|r| r.as_ref().err()).unwrap().0,
        "REVISION_CONFLICT"
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks.len(), 1);
    assert_eq!(repo.read_history().unwrap().undo_count, 1);
}
#[test]
fn atomic_edits_identity_revisions_receipts_and_reopen() {
    let (dir, repo, project) = setup();
    let first = id();
    let second = id();
    let insert = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&first,"你好 🐦 é"),"after":null}]),
        json!([]),
    );
    let receipt = repo.execute_manuscript(&insert).unwrap();
    assert_eq!(receipt.working_revision, 2);
    assert_eq!(receipt.block_revisions[0].revision, 1);
    assert_eq!(repo.execute_manuscript(&insert).unwrap(), receipt);
    assert_eq!(repo.command_receipt(&receipt.request_id).unwrap(), receipt);
    let mut altered = serde_json::to_value(&insert).unwrap();
    altered["expectedWorkingRevision"] = json!(2);
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(altered).unwrap())
            .unwrap_err()
            .0,
        "REQUEST_ID_CONFLICT"
    );
    let before = repo.read_manuscript().unwrap();
    let invalid = command(
        &project,
        2,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"lost?","marks":[]}]},{"op":"deleteBlock","id":id()}]),
        json!([{"id":first,"revision":1}]),
    );
    assert!(repo.execute_manuscript(&invalid).is_err());
    assert_eq!(repo.read_manuscript().unwrap(), before);
    let split = command(
        &project,
        2,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"你好 ","marks":[]}]},{"op":"insertBlock","block":block(&second,"🐦 é"),"after":first}]),
        json!([{"id":first,"revision":1}]),
    );
    repo.execute_manuscript(&split).unwrap();
    let split_state = repo.read_manuscript().unwrap();
    assert_eq!(split_state.blocks[0].id, first);
    assert_eq!(split_state.blocks[0].revision, 2);
    assert_eq!(split_state.blocks[1].revision, 1);
    let merge = command(
        &project,
        3,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"你好 🐦 é","marks":[]}]},{"op":"deleteBlock","id":second}]),
        json!([{"id":first,"revision":2},{"id":second,"revision":1}]),
    );
    let receipt = repo.execute_manuscript(&merge).unwrap();
    assert!(
        receipt
            .block_revisions
            .iter()
            .any(|r| r.id == second && r.revision == 2)
    );
    let reuse = command(
        &project,
        4,
        json!([{"op":"insertBlock","block":block(&second,"reuse"),"after":first}]),
        json!([]),
    );
    assert!(repo.execute_manuscript(&reuse).is_err());
    let saved = repo.read_manuscript().unwrap();
    drop(repo);
    let reopened = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(reopened.read_manuscript().unwrap(), saved);
}
struct Protected(String);
impl MutationPolicy for Protected {
    fn validate(
        &self,
        _: &ManuscriptState,
        _: &ManuscriptState,
        affected: &BTreeSet<String>,
    ) -> std::result::Result<(), ManuscriptError> {
        if affected.contains(&self.0) {
            Err(ManuscriptError("CONTENT_LOCKED", None))
        } else {
            Ok(())
        }
    }
}
#[test]
fn policy_uses_net_structural_impact_and_allows_independent_siblings() {
    let (_dir, repo, project) = setup();
    let protected = id();
    let sibling = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&protected,"Protected"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let repo = repo.with_policy(Arc::new(Protected(protected.clone())));
    let noop = command(
        &project,
        2,
        json!([{"op":"moveBlocks","ids":[protected],"after":null}]),
        json!([{"id":protected,"revision":1}]),
    );
    assert_eq!(repo.execute_manuscript(&noop).unwrap().working_revision, 2);
    repo.execute_manuscript(&command(
        &project,
        2,
        json!([{"op":"insertBlock","block":block(&sibling,"Independent sibling"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let mut heading = block(&id(), "Parent");
    heading["kind"] = json!("heading");
    heading["attrs"]["level"] = json!(1);
    let before = repo.read_manuscript().unwrap();
    let rejected = command(
        &project,
        3,
        json!([{"op":"insertBlock","block":heading,"after":sibling}]),
        json!([{"id":protected,"revision":1}]),
    );
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "CONTENT_LOCKED"
    );
    assert_eq!(repo.read_manuscript().unwrap(), before);
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "CONTENT_LOCKED"
    );
    let direct = command(
        &project,
        3,
        json!([{"op":"setBlockContent","id":protected,"runs":[]}]),
        json!([{"id":protected,"revision":1}]),
    );
    assert_eq!(
        repo.execute_manuscript(&direct).unwrap_err().0,
        "CONTENT_LOCKED"
    );
}
#[test]
fn unicode_marks_lists_limits_and_closed_commands() {
    let (_dir, repo, project) = setup();
    let first = id();
    let mut rich = block(&first, "Chinese 中文 🐦 é\nline");
    rich["runs"] =
        json!([{"text":"Chinese 中文 🐦 é\nline","marks":[{"type":"italic"},{"type":"bold"}]}]);
    let receipt = repo
        .execute_manuscript(&command(
            &project,
            1,
            json!([{"op":"insertBlock","block":rich,"after":null}]),
            json!([]),
        ))
        .unwrap();
    assert!(receipt.normalized);
    let before = repo.read_manuscript().unwrap();
    let bad_link = command(
        &project,
        2,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"unsafe","marks":[{"type":"link","href":"javascript:alert(1)"}]}]}]),
        json!([{"id":first,"revision":1}]),
    );
    assert_eq!(
        repo.execute_manuscript(&bad_link).unwrap_err().0,
        "DOCUMENT_INVALID"
    );
    let mut list = block(&id(), "orphan");
    list["kind"] = json!("list_item");
    list["attrs"] = json!({"depth":2,"listKind":"bullet"});
    assert!(
        repo.execute_manuscript(&command(
            &project,
            2,
            json!([{"op":"insertBlock","block":list,"after":first}]),
            json!([])
        ))
        .is_err()
    );
    let huge = block(&id(), &"x".repeat(1024 * 1024 + 1));
    assert_eq!(
        repo.execute_manuscript(&command(
            &project,
            2,
            json!([{"op":"insertBlock","block":huge,"after":first}]),
            json!([])
        ))
        .unwrap_err()
        .0,
        "DOCUMENT_TOO_LARGE"
    );
    assert_eq!(repo.read_manuscript().unwrap(), before);
    let mut missing = serde_json::to_value(command(
        &project,
        2,
        json!([{"op":"moveBlocks","ids":[first],"after":null}]),
        json!([]),
    ))
    .unwrap();
    missing["payload"]["operations"][0]
        .as_object_mut()
        .unwrap()
        .remove("after");
    assert!(serde_json::from_value::<ManuscriptCommand>(missing).is_err());
    let invalid_split = command(
        &project,
        2,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"Chinese 中文 🐦 e","marks":[]}]},{"op":"insertBlock","block":block(&id(),"́\nline"),"after":first}]),
        json!([{"id":first,"revision":1}]),
    );
    assert!(repo.execute_manuscript(&invalid_split).is_err());
}
#[test]
fn object_and_transaction_failures_leave_no_receipt_or_partial_state() {
    let (dir, repo, project) = setup();
    let first = id();
    let command = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&first,"Durable"),"after":null}]),
        json!([]),
    );
    {
        let c = repo.connection.lock().unwrap();
        c.execute_batch("CREATE TRIGGER inject_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
    }
    assert_eq!(
        repo.execute_manuscript(&command).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert!(repo.read_manuscript().unwrap().blocks.is_empty());
    assert_eq!(
        repo.command_receipt(scenesparrow_domain::manuscript::envelope(&command).0)
            .unwrap_err()
            .0,
        "COMMAND_NOT_FOUND"
    );
    {
        let c = repo.connection.lock().unwrap();
        c.execute_batch("DROP TRIGGER inject_failure;").unwrap();
    }
    repo.execute_manuscript(&command).unwrap();
    let state = repo.read_manuscript().unwrap();
    let digest: String = repo
        .connection
        .lock()
        .unwrap()
        .query_row("SELECT payload_hash FROM blocks", [], |r| r.get(0))
        .unwrap();
    std::fs::remove_file(dir.path().join("objects").join(digest)).unwrap();
    drop(repo);
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    assert_eq!(state.blocks[0].runs[0].text, "Durable");
}
#[test]
fn consistent_bootstrap_backup_and_unknown_schema_no_write() {
    let dir = tempfile::tempdir().unwrap();
    let c = Connection::open(dir.path().join("project.sqlite")).unwrap();
    c.execute_batch(include_str!("../migrations/001_project.sql"))
        .unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    let project = id();
    c.execute(
        "INSERT INTO project VALUES(1,?1,'标题','old',0,NULL)",
        [&project],
    )
    .unwrap();
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read().unwrap().unwrap().id, project);
    assert_eq!(
        repo.read_manuscript().unwrap().workspace_stage,
        ManuscriptStateWorkspaceStage::Outline
    );
    let backup = Connection::open(dir.path().join("pre-migration-002.sqlite")).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT title FROM project", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "标题"
    );
    assert_eq!(
        backup
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(repo);
    drop(c);
    drop(backup);
    let unknown = tempfile::tempdir().unwrap();
    let path = unknown.path().join("project.sqlite");
    let c = Connection::open(&path).unwrap();
    c.pragma_update(None, "user_version", 99).unwrap();
    drop(c);
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        SqliteProjectRepository::open(unknown.path()),
        Err(Error::SchemaUnsupported)
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}
#[test]
fn rejected_group_outcome_and_project_identity_are_stable() {
    let (_dir, repo, project) = setup();
    let first = id();
    let reserved = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&project,"Reserved project ID"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&reserved).unwrap_err().0,
        "DOCUMENT_INVALID"
    );
    let mut rejected = serde_json::to_value(command(
        &project,
        2,
        json!([{"op":"insertBlock","block":block(&first,"Should not appear"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    rejected["payload"]["group"]["groupSequence"] = json!(2);
    let rejected: ManuscriptCommand = serde_json::from_value(rejected).unwrap();
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "REVISION_CONFLICT"
    );
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&id(),"Other edit"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let before = repo.read_manuscript().unwrap();
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        repo.command_receipt(scenesparrow_domain::manuscript::envelope(&rejected).0)
            .unwrap_err()
            .0,
        "REVISION_CONFLICT"
    );
    assert_eq!(repo.read_manuscript().unwrap(), before);
}
#[test]
fn migration_failure_rolls_back_and_can_retry_without_overwriting_backup() {
    let dir = tempfile::tempdir().unwrap();
    let c = Connection::open(dir.path().join("project.sqlite")).unwrap();
    c.execute_batch(include_str!("../migrations/001_project.sql"))
        .unwrap();
    c.execute(
        "INSERT INTO project VALUES(1,?1,'Preserved','old',0,NULL)",
        [id()],
    )
    .unwrap();
    c.execute_batch("CREATE TABLE blocks (conflict INTEGER)")
        .unwrap();
    drop(c);
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    let backup = std::fs::read(dir.path().join("pre-migration-002.sqlite")).unwrap();
    let c = Connection::open(dir.path().join("project.sqlite")).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        c.query_row("SELECT COUNT(*) FROM manuscripts", [], |r| r
            .get::<_, i64>(0))
            .is_err()
    );
    c.execute_batch("DROP TABLE blocks").unwrap();
    drop(c);
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read().unwrap().unwrap().title, "Preserved");
    assert_eq!(repo.read_manuscript().unwrap().blocks.len(), 0);
    assert_eq!(
        std::fs::read(dir.path().join("pre-migration-002.sqlite")).unwrap(),
        backup
    );
}
#[test]
fn final_revision_digits_cannot_exceed_document_limit() {
    let (dir, repo, project) = setup();
    let first = id();
    let mut rich = block(&first, "a");
    rich["runs"][0]["marks"] = json!([{"type":"link","href":"https://example.com/"}]);
    let mut expected = repo.read_manuscript().unwrap();
    expected.working_revision = 2;
    let mut candidate: Block = serde_json::from_value({
        let mut b = rich.clone();
        b["revision"] = json!(1);
        b
    })
    .unwrap();
    let current = serde_json::to_vec(&{
        let mut s = expected.clone();
        s.blocks = vec![candidate.clone()];
        s
    })
    .unwrap()
    .len();
    let fill = scenesparrow_domain::manuscript::MAX_DOCUMENT_BYTES - current;
    candidate.runs[0].marks[0]
        .href
        .as_mut()
        .unwrap()
        .push_str(&"x".repeat(fill));
    let mut new = serde_json::to_value(&candidate).unwrap();
    new.as_object_mut().unwrap().remove("revision");
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":new,"after":null}]),
        json!([]),
    ))
    .unwrap();
    for revision in 2..9 {
        let mut runs = candidate.runs.clone();
        runs[0].text = if revision % 2 == 0 { "b" } else { "a" }.to_owned();
        repo.execute_manuscript(&command(
            &project,
            revision,
            json!([{"op":"setBlockContent","id":first,"runs":runs}]),
            json!([{"id":first,"revision":revision-1}]),
        ))
        .unwrap();
    }
    let before = repo.read_manuscript().unwrap();
    assert_eq!(before.working_revision, 9);
    let mut runs = candidate.runs.clone();
    runs[0].text = "c".to_owned();
    let rejected = command(
        &project,
        9,
        json!([{"op":"setBlockContent","id":first,"runs":runs}]),
        json!([{"id":first,"revision":8}]),
    );
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "DOCUMENT_TOO_LARGE"
    );
    assert_eq!(repo.read_manuscript().unwrap(), before);
    drop(repo);
    assert_eq!(
        SqliteProjectRepository::open(dir.path())
            .unwrap()
            .read_manuscript()
            .unwrap(),
        before
    );
}
#[test]
fn exhaustion_rejection_receipt_is_immutable() {
    let (_dir, repo, project) = setup();
    let first = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&first,"a"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE object_identities SET high_water=9007199254740991 WHERE id=?1",
            [&first],
        )
        .unwrap();
    let rejected = command(
        &project,
        2,
        json!([{"op":"setBlockContent","id":first,"runs":[{"text":"b","marks":[]}]}]),
        json!([{"id":first,"revision":1}]),
    );
    for _ in 0..2 {
        assert_eq!(
            repo.execute_manuscript(&rejected).unwrap_err().0,
            "REVISION_EXHAUSTED"
        );
    }
    assert_eq!(
        repo.command_receipt(scenesparrow_domain::manuscript::envelope(&rejected).0)
            .unwrap_err()
            .0,
        "REVISION_EXHAUSTED"
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks[0].runs[0].text, "a");
}
#[test]
fn object_write_failure_preserves_state_and_no_receipt() {
    let (dir, repo, project) = setup();
    let staging = dir.path().join("staging");
    std::fs::remove_dir(&staging).unwrap();
    std::fs::write(&staging, "blocked").unwrap();
    let c = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&id(),"unsaved"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&c).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        repo.command_receipt(scenesparrow_domain::manuscript::envelope(&c).0)
            .unwrap_err()
            .0,
        "COMMAND_NOT_FOUND"
    );
    assert!(repo.read_manuscript().unwrap().blocks.is_empty());
}
#[test]
fn empty_manual_draft_reopens_without_persisting_editor_placeholder() {
    let (dir, repo, _project) = setup();
    let empty = repo.read_manuscript().unwrap();
    assert_eq!(empty.workspace_stage, ManuscriptStateWorkspaceStage::Draft);
    assert!(empty.blocks.is_empty());
    drop(repo);
    assert_eq!(
        SqliteProjectRepository::open(dir.path())
            .unwrap()
            .read_manuscript()
            .unwrap(),
        empty
    );
}
#[test]
fn moves_a_derived_heading_section_with_stable_ids() {
    let (_dir, repo, project) = setup();
    let ids = [id(), id(), id(), id()];
    let mut operations = vec![];
    for (i, id) in ids.iter().enumerate() {
        let mut b = block(id, &format!("block {i}"));
        if i % 2 == 0 {
            b["kind"] = json!("heading");
            b["attrs"] = json!({"level":1});
        }
        operations
            .push(json!({"op":"insertBlock","block":b,"after":i.checked_sub(1).map(|n|&ids[n])}));
    }
    repo.execute_manuscript(&command(&project, 1, json!(operations), json!([])))
        .unwrap();
    repo.execute_manuscript(&command(
        &project,
        2,
        json!([{"op":"moveBlocks","ids":[ids[0],ids[1]],"after":ids[3]}]),
        json!([{"id":ids[0],"revision":1},{"id":ids[1],"revision":1}]),
    ))
    .unwrap();
    let state = repo.read_manuscript().unwrap();
    assert_eq!(
        state.blocks.iter().map(|b| &b.id).collect::<Vec<_>>(),
        vec![&ids[2], &ids[3], &ids[0], &ids[1]]
    );
    assert_eq!(state.blocks[2].revision, 2);
    assert_eq!(state.blocks[3].revision, 2);
    assert_eq!(state.blocks[0].revision, 1);
}
#[test]
fn reparented_descendants_require_their_own_revision_preconditions() {
    let (_dir, repo, project) = setup();
    let first = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&first,"Existing child"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let mut parent = block(&id(), "Parent");
    parent["kind"] = json!("heading");
    parent["attrs"] = json!({"level":1});
    let operations = json!([{"op":"insertBlock","block":parent,"after":null}]);
    let missing = command(&project, 2, operations.clone(), json!([]));
    assert_eq!(
        repo.execute_manuscript(&missing).unwrap_err().0,
        "REVISION_CONFLICT"
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks.len(), 1);
    repo.execute_manuscript(&command(
        &project,
        2,
        operations,
        json!([{"id":first,"revision":1}]),
    ))
    .unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[1].revision, 2);
}
#[test]
fn policy_is_rechecked_after_object_preparation_before_commit() {
    struct RestrictAtCommit(std::sync::atomic::AtomicUsize);
    impl MutationPolicy for RestrictAtCommit {
        fn validate(
            &self,
            _: &ManuscriptState,
            _: &ManuscriptState,
            _: &BTreeSet<String>,
        ) -> std::result::Result<(), ManuscriptError> {
            if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(ManuscriptError("TASK_USING_CONTENT", None))
            }
        }
    }
    let (_dir, repo, project) = setup();
    let repo = repo.with_policy(Arc::new(RestrictAtCommit(
        std::sync::atomic::AtomicUsize::new(0),
    )));
    let c = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&id(),"Prepared but rejected"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&c).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    assert_eq!(
        repo.execute_manuscript(&c).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    assert!(repo.read_manuscript().unwrap().blocks.is_empty());
}
#[test]
fn exhausted_tombstone_rejection_has_an_immutable_receipt() {
    let (_dir, repo, project) = setup();
    let first = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&first,"Keep this block"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE object_identities SET high_water=9007199254740991 WHERE id=?1",
            [&first],
        )
        .unwrap();
    let rejected = command(
        &project,
        2,
        json!([{"op":"deleteBlock","id":first}]),
        json!([{"id":first,"revision":1}]),
    );
    let before = repo.read_manuscript().unwrap();
    for _ in 0..2 {
        assert_eq!(
            repo.execute_manuscript(&rejected).unwrap_err().0,
            "REVISION_EXHAUSTED"
        );
    }
    let request = scenesparrow_domain::manuscript::envelope(&rejected).0;
    assert_eq!(
        repo.command_receipt(request).unwrap_err().0,
        "REVISION_EXHAUSTED"
    );
    let mut altered = serde_json::to_value(&rejected).unwrap();
    altered["payload"]["operations"] = json!([]);
    altered["payload"]["expectedBlockRevisions"] = json!([]);
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(altered).unwrap())
            .unwrap_err()
            .0,
        "REQUEST_ID_CONFLICT"
    );
    assert_eq!(repo.read_manuscript().unwrap(), before);
    let c = repo.connection.lock().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT tombstoned FROM object_identities WHERE id=?1",
            [&first],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM project_events WHERE event_type='manuscript.changed'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}
#[test]
fn direct_group_validation_rejection_is_receipted_before_revision_changes() {
    let (_dir, repo, project) = setup();
    let mut rejected = serde_json::to_value(command(&project, 1, json!([]), json!([]))).unwrap();
    rejected["payload"]["group"]["groupSequence"] = json!(2);
    let rejected: ManuscriptCommand = serde_json::from_value(rejected).unwrap();
    let request = scenesparrow_domain::manuscript::envelope(&rejected).0;
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "INVALID_REQUEST"
    );
    assert_eq!(
        repo.command_receipt(request).unwrap_err().0,
        "INVALID_REQUEST"
    );
    let mut corrected = serde_json::to_value(&rejected).unwrap();
    corrected["payload"]["group"]["groupSequence"] = json!(1);
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(corrected.clone()).unwrap())
            .unwrap_err()
            .0,
        "REQUEST_ID_CONFLICT"
    );
    corrected["requestId"] = json!(id());
    corrected["payload"]["operations"] =
        json!([{"op":"insertBlock","block":block(&id(),"New group accepted"),"after":null}]);
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(corrected).unwrap())
            .unwrap()
            .working_revision,
        2
    );
    assert_eq!(
        repo.execute_manuscript(&rejected).unwrap_err().0,
        "INVALID_REQUEST"
    );
    assert_eq!(
        repo.command_receipt(request).unwrap_err().0,
        "INVALID_REQUEST"
    );
    assert_eq!(repo.read_manuscript().unwrap().blocks.len(), 1);
}

fn history_command(repo: &SqliteProjectRepository, project: &str, kind: &str) -> ManuscriptCommand {
    let h = repo.read_history().unwrap();
    serde_json::from_value(json!({"type":kind,"requestId":id(),"projectId":project,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap()
}
fn replace_text(repo: &SqliteProjectRepository, project: &str, text: &str) -> ManuscriptCommand {
    let s = repo.read_manuscript().unwrap();
    let b = &s.blocks[0];
    command(
        project,
        s.working_revision,
        json!([{"op":"setBlockContent","id":b.id,"runs":[{"text":text,"marks":[]}]}]),
        json!([{"id":b.id,"revision":b.revision}]),
    )
}
#[test]
fn bounded_history_prunes_shares_six_roots_and_reopens_midcursor() {
    let (dir, repo, project) = setup();
    let b = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"0"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    for n in 1..=7 {
        repo.execute_manuscript(&replace_text(&repo, &project, &n.to_string()))
            .unwrap();
    }
    let h = repo.read_history().unwrap();
    assert_eq!((h.cursor, h.undo_count, h.redo_count), (5, 5, 0));
    {
        let c = repo.connection.lock().unwrap();
        let count:i64=c.query_row("SELECT COUNT(*) FROM (SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries)",[],|r|r.get(0)).unwrap();
        assert_eq!(count, 6);
        let count:i64=c.query_row("SELECT COUNT(*) FROM edit_groups WHERE closed=1 AND (before_hash IS NOT NULL OR after_hash<>'')",[],|r|r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
    assert!(repo.retained_object_roots().unwrap().len() <= 8);
    let mut previous_revision = repo.read_manuscript().unwrap().blocks[0].revision;
    for n in (2..=6).rev() {
        let receipt = repo
            .execute_manuscript(&history_command(&repo, &project, "UndoProject"))
            .unwrap();
        let s = repo.read_manuscript().unwrap();
        assert_eq!(s.blocks[0].runs[0].text, n.to_string());
        assert!(s.blocks[0].revision > previous_revision);
        previous_revision = s.blocks[0].revision;
        assert_eq!(receipt.undo_count, n - 2);
    }
    assert_eq!(
        repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
            .unwrap_err()
            .0,
        "HISTORY_EMPTY"
    );
    for _ in 0..3 {
        repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
            .unwrap();
    }
    let mid = repo.read_manuscript().unwrap();
    let h = repo.read_history().unwrap();
    assert_eq!((h.cursor, h.redo_count), (3, 2));
    drop(repo);
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read_manuscript().unwrap(), mid);
    assert_eq!(repo.read_history().unwrap(), h);
    for _ in 0..2 {
        repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
            .unwrap();
    }
    assert_eq!(repo.read_manuscript().unwrap().blocks[0].runs[0].text, "7");
    assert_eq!(
        repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
            .unwrap_err()
            .0,
        "HISTORY_EMPTY"
    );
}
#[test]
fn stage_history_and_deleted_identity_restore_preserve_high_water() {
    let (_dir, repo, project) = setup();
    repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
        .unwrap();
    assert_eq!(
        repo.read_manuscript().unwrap().workspace_stage,
        ManuscriptStateWorkspaceStage::Outline
    );
    repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
        .unwrap();
    let b = id();
    let s = repo.read_manuscript().unwrap();
    repo.execute_manuscript(&command(
        &project,
        s.working_revision,
        json!([{"op":"insertBlock","block":block(&b,"Original"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let s = repo.read_manuscript().unwrap();
    repo.execute_manuscript(&command(
        &project,
        s.working_revision,
        json!([{"op":"deleteBlock","id":b}]),
        json!([{"id":b,"revision":s.blocks[0].revision}]),
    ))
    .unwrap();
    let deleted = repo.read_manuscript().unwrap();
    repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
        .unwrap();
    let restored = repo.read_manuscript().unwrap();
    assert_eq!(restored.blocks[0].id, b);
    assert!(restored.blocks[0].revision > 2);
    repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
        .unwrap();
    let s = repo.read_manuscript().unwrap();
    assert!(s.working_revision > deleted.working_revision);
    let reuse = command(
        &project,
        s.working_revision,
        json!([{"op":"insertBlock","block":block(&b,"Recycled"),"after":null}]),
        json!([]),
    );
    assert_eq!(
        repo.execute_manuscript(&reuse).unwrap_err().0,
        "DOCUMENT_INVALID"
    );
}
#[test]
fn grouped_saved_batches_noop_sequence_tail_and_closed_session_rules() {
    let (_dir, repo, project) = setup();
    let b = id();
    let mut edit = serde_json::to_value(command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"a"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    edit["payload"]["group"]["kind"] = json!("typing");
    let group = edit["payload"]["group"].clone();
    let first: ManuscriptCommand = serde_json::from_value(edit).unwrap();
    let initial = repo.execute_manuscript(&first).unwrap();
    for (n, text) in [(2, "ab"), (3, "abc")] {
        let mut next = serde_json::to_value(replace_text(&repo, &project, text)).unwrap();
        next["payload"]["group"] = group.clone();
        next["payload"]["group"]["groupSequence"] = json!(n);
        repo.execute_manuscript(&serde_json::from_value(next).unwrap())
            .unwrap();
    }
    assert_eq!(repo.read_history().unwrap().undo_count, 2);
    assert_eq!(repo.execute_manuscript(&first).unwrap(), initial);
    let mut noop = serde_json::to_value(replace_text(&repo, &project, "abc")).unwrap();
    noop["payload"]["group"] = group.clone();
    noop["payload"]["group"]["groupSequence"] = json!(4);
    let before = repo.read_history().unwrap();
    repo.execute_manuscript(&serde_json::from_value(noop).unwrap())
        .unwrap();
    assert_eq!(repo.read_history().unwrap(), before);
    let mut next = serde_json::to_value(replace_text(&repo, &project, "abcd")).unwrap();
    next["payload"]["group"] = group.clone();
    next["payload"]["group"]["groupSequence"] = json!(5);
    repo.execute_manuscript(&serde_json::from_value(next).unwrap())
        .unwrap();
    assert_eq!(repo.read_history().unwrap().undo_count, 2);
    let stale = history_command(&repo, &project, "UndoProject");
    let h = repo.read_history().unwrap();
    let close:ManuscriptCommand=serde_json::from_value(json!({"type":"CloseEditGroup","requestId":id(),"projectId":project,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{"clientSessionId":group["clientSessionId"],"groupId":group["groupId"],"groupSequence":5}})).unwrap();
    let receipt = repo.execute_manuscript(&close).unwrap();
    assert_eq!(receipt.working_revision, h.working_revision);
    assert_eq!(receipt.history_revision, h.history_revision + 1);
    assert_eq!(
        repo.execute_manuscript(&stale).unwrap_err().0,
        "HISTORY_CONFLICT"
    );
    assert_eq!(repo.execute_manuscript(&close).unwrap(), receipt);
    let mut again = serde_json::to_value(close).unwrap();
    again["requestId"] = json!(id());
    again["expectedHistoryRevision"] = json!(receipt.history_revision);
    repo.execute_manuscript(&serde_json::from_value(again).unwrap())
        .unwrap();
    assert_eq!(
        repo.read_history().unwrap().history_revision,
        receipt.history_revision
    );
    repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
        .unwrap();
    let h = repo.read_history().unwrap();
    repo.execute_manuscript(&command(&project, h.working_revision, json!([]), json!([])))
        .unwrap();
    assert_eq!(repo.read_history().unwrap(), h);
    let s = repo.read_manuscript().unwrap();
    let fresh = id();
    repo.execute_manuscript(&command(
        &project,
        s.working_revision,
        json!([{"op":"insertBlock","block":block(&fresh,"branch"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    assert_eq!(repo.read_history().unwrap().redo_count, 0);
    let mut closed = serde_json::to_value(replace_text(&repo, &project, "bad session")).unwrap();
    closed["payload"]["group"] = group;
    closed["payload"]["group"]["groupSequence"] = json!(6);
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(closed).unwrap())
            .unwrap_err()
            .0,
        "INVALID_REQUEST"
    );
}
#[test]
fn history_policy_blocks_descendants_but_not_independent_stationary_siblings() {
    let (_dir, repo, project) = setup();
    let protected = id();
    let sibling = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&protected,"Protected"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    repo.execute_manuscript(&command(
        &project,
        2,
        json!([{"op":"insertBlock","block":block(&sibling,"Independent"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let repo = repo.with_policy(Arc::new(Protected(protected.clone())));
    repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
        .unwrap();
    repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
        .unwrap();
    assert_eq!(repo.read_manuscript().unwrap().blocks[1].revision, 1);
    let repo = repo.with_policy(Arc::new(scenesparrow_domain::manuscript::Unrestricted));
    let mut heading = block(&id(), "Heading");
    heading["kind"] = json!("heading");
    heading["attrs"] = json!({"level":1});
    let s = repo.read_manuscript().unwrap();
    repo.execute_manuscript(&command(
        &project,
        s.working_revision,
        json!([{"op":"insertBlock","block":heading,"after":null}]),
        json!(
            s.blocks
                .iter()
                .map(|b| json!({"id":b.id,"revision":b.revision}))
                .collect::<Vec<_>>()
        ),
    ))
    .unwrap();
    let repo = repo.with_policy(Arc::new(Protected(protected.clone())));
    let h = repo.read_history().unwrap();
    let s = repo.read_manuscript().unwrap();
    let undo = history_command(&repo, &project, "UndoProject");
    let rejected = repo.execute_manuscript(&undo).unwrap_err();
    assert_eq!(rejected.0, "HISTORY_BLOCKED");
    assert_eq!(rejected.1.as_ref().unwrap().reason, "CONTENT_LOCKED");
    assert!(
        rejected
            .1
            .as_ref()
            .unwrap()
            .affected_ids
            .contains(&protected)
    );
    assert_eq!(
        repo.command_receipt(scenesparrow_domain::manuscript::envelope(&undo).0)
            .unwrap_err(),
        rejected
    );
    assert_eq!(
        repo.execute_manuscript(&undo).unwrap_err().0,
        "HISTORY_BLOCKED"
    );
    assert_eq!(repo.read_history().unwrap(), h);
    assert_eq!(repo.read_manuscript().unwrap(), s);
    let repo = repo.with_policy(Arc::new(scenesparrow_domain::manuscript::Unrestricted));
    repo.execute_manuscript(&history_command(&repo, &project, "UndoProject"))
        .unwrap();
    let repo = repo.with_policy(Arc::new(Protected(protected)));
    let h = repo.read_history().unwrap();
    assert_eq!(
        repo.execute_manuscript(&history_command(&repo, &project, "RedoProject"))
            .unwrap_err()
            .0,
        "HISTORY_BLOCKED"
    );
    assert_eq!(repo.read_history().unwrap(), h);
}
#[test]
fn missing_retained_history_prevents_reopen_and_exhausted_group_can_be_fenced() {
    let (dir, repo, project) = setup();
    let b = id();
    repo.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE history_cursor SET history_revision=9007199254740990",
            [],
        )
        .unwrap();
    let c = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"Latest"),"after":null}]),
        json!([]),
    );
    repo.execute_manuscript(&c).unwrap();
    let state = repo.read_manuscript().unwrap();
    drop(repo);
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(
        repo.read_history().unwrap().history_revision,
        9007199254740991
    );
    let digest: String = repo
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT before_hash FROM history_entries ORDER BY position LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    drop(repo);
    std::fs::remove_file(dir.path().join("objects").join(digest)).unwrap();
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
}

#[test]
fn history_faults_leave_body_cursor_and_receipt_atomic_and_retryable() {
    let (dir, repo, project) = setup();
    let b = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"Durable"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let undo = history_command(&repo, &project, "UndoProject");
    let state = repo.read_manuscript().unwrap();
    let history = repo.read_history().unwrap();
    let request = scenesparrow_domain::manuscript::envelope(&undo).0;
    std::fs::remove_dir(dir.path().join("staging")).unwrap();
    std::fs::write(dir.path().join("staging"), "blocked").unwrap();
    assert_eq!(
        repo.execute_manuscript(&undo).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        repo.command_receipt(request).unwrap_err().0,
        "COMMAND_NOT_FOUND"
    );
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(repo.read_history().unwrap(), history);
    std::fs::remove_file(dir.path().join("staging")).unwrap();
    std::fs::create_dir(dir.path().join("staging")).unwrap();
    repo.connection.lock().unwrap().execute_batch("CREATE TRIGGER history_receipt_fault BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'fault'); END;").unwrap();
    assert_eq!(
        repo.execute_manuscript(&undo).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        repo.command_receipt(request).unwrap_err().0,
        "COMMAND_NOT_FOUND"
    );
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(repo.read_history().unwrap(), history);
    repo.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER history_receipt_fault")
        .unwrap();
    let receipt = repo.execute_manuscript(&undo).unwrap();
    assert_eq!(repo.execute_manuscript(&undo).unwrap(), receipt);
    assert_eq!(receipt.cursor, history.cursor - 1);
}
#[test]
fn history_policy_is_rechecked_after_preparation_and_rejection_is_durable() {
    struct AtCommit(std::sync::atomic::AtomicUsize);
    impl MutationPolicy for AtCommit {
        fn validate(
            &self,
            _: &ManuscriptState,
            _: &ManuscriptState,
            _: &BTreeSet<String>,
        ) -> std::result::Result<(), ManuscriptError> {
            if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(ManuscriptError("TASK_USING_CONTENT", None))
            }
        }
    }
    let (_dir, repo, project) = setup();
    let b = id();
    repo.execute_manuscript(&command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"Keep"),"after":null}]),
        json!([]),
    ))
    .unwrap();
    let state = repo.read_manuscript().unwrap();
    let history = repo.read_history().unwrap();
    let repo = repo.with_policy(Arc::new(AtCommit(std::sync::atomic::AtomicUsize::new(0))));
    let undo = history_command(&repo, &project, "UndoProject");
    assert_eq!(
        repo.execute_manuscript(&undo).unwrap_err().0,
        "HISTORY_BLOCKED"
    );
    assert_eq!(
        repo.execute_manuscript(&undo).unwrap_err().0,
        "HISTORY_BLOCKED"
    );
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(repo.read_history().unwrap(), history);
}
#[test]
fn migrate_acknowledged_v2_draft_with_pinned_backup_and_transactional_retry() {
    let (dir, repo, project) = setup();
    let b = id();
    let edit = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"Existing acknowledged draft"),"after":null}]),
        json!([]),
    );
    let mut receipt = serde_json::to_value(repo.execute_manuscript(&edit).unwrap()).unwrap();
    let state = repo.read_manuscript().unwrap();
    receipt["historyRevision"] = json!(0);
    receipt["cursor"] = json!(0);
    receipt["undoCount"] = json!(0);
    receipt["redoCount"] = json!(0);
    receipt.as_object_mut().unwrap().remove("undoLabel");
    receipt.as_object_mut().unwrap().remove("redoLabel");
    drop(repo);
    let c = Connection::open(dir.path().join("project.sqlite")).unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    super::drop_ai_schema_for_legacy_fixture(&c);
    c.execute_batch("DROP TABLE sources; DROP TABLE intakes; DROP TABLE document_attempts; DROP TABLE import_provenance; DROP TABLE external_object_pins; DROP TABLE history_entries; DROP TABLE history_cursor; ALTER TABLE edit_groups DROP COLUMN scope_block_id; ALTER TABLE edit_groups DROP COLUMN last_commit_ms; UPDATE edit_groups SET closed=0; PRAGMA user_version=2;").unwrap();
    c.execute(
        "UPDATE command_receipts SET outcome_json=?1 WHERE request_id=?2",
        params![
            receipt.to_string(),
            scenesparrow_domain::manuscript::envelope(&edit).0
        ],
    )
    .unwrap();
    c.execute_batch("CREATE TABLE history_cursor (conflict INTEGER)")
        .unwrap();
    let backups = || {
        std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pre-migration-003-")
            })
            .collect::<BTreeSet<_>>()
    };
    let previous = backups();
    assert!(SqliteProjectRepository::open(dir.path()).is_err());
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let backup = backups().difference(&previous).next().unwrap().clone();
    let original = std::fs::read(backup.join("project.sqlite")).unwrap();
    let digest: String = c
        .query_row("SELECT snapshot_hash FROM manuscripts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        std::fs::read(backup.join("objects").join(&digest)).unwrap(),
        std::fs::read(dir.path().join("objects").join(&digest)).unwrap()
    );
    c.execute_batch("DROP TABLE history_cursor").unwrap();
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(repo.read_history().unwrap().undo_count, 0);
    assert_eq!(repo.read_history().unwrap().redo_count, 0);
    assert_eq!(
        serde_json::to_value(repo.execute_manuscript(&edit).unwrap()).unwrap(),
        receipt
    );
    assert_eq!(
        std::fs::read(backup.join("project.sqlite")).unwrap(),
        original
    );
    let c = repo.connection.lock().unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM edit_groups WHERE closed=0", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn server_derives_typing_scope_and_separates_moves_formatting_and_other_blocks() {
    let (_dir, repo, project) = setup();
    let a = id();
    let b = id();
    repo.execute_manuscript(&command(&project,1,json!([{"op":"insertBlock","block":block(&a,"A"),"after":null},{"op":"insertBlock","block":block(&b,"B"),"after":a}]),json!([]))).unwrap();
    let group = json!({"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"typing"});
    let send = |sequence: i64, operations: Value| {
        let s = repo.read_manuscript().unwrap();
        let mut c = serde_json::to_value(command(
            &project,
            s.working_revision,
            operations,
            json!(
                s.blocks
                    .iter()
                    .map(|b| json!({"id":b.id,"revision":b.revision}))
                    .collect::<Vec<_>>()
            ),
        ))
        .unwrap();
        c["payload"]["group"] = group.clone();
        c["payload"]["group"]["groupSequence"] = json!(sequence);
        repo.execute_manuscript(&serde_json::from_value(c).unwrap())
            .unwrap()
    };
    send(
        1,
        json!([{"op":"setBlockContent","id":a,"runs":[{"text":"Typed A","marks":[]}]}]),
    );
    assert_eq!(repo.read_history().unwrap().cursor, 3);
    send(2, json!([{"op":"moveBlocks","ids":[a],"after":b}]));
    assert_eq!(repo.read_history().unwrap().cursor, 4);
    send(
        3,
        json!([{"op":"setBlockContent","id":b,"runs":[{"text":"Typed B","marks":[]}]}]),
    );
    assert_eq!(repo.read_history().unwrap().cursor, 5);
    let first_after: String = repo
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT after_hash FROM history_entries WHERE position=5",
            [],
            |r| r.get(0),
        )
        .unwrap();
    send(
        4,
        json!([{"op":"setBlockContent","id":b,"runs":[{"text":"Typed B","marks":[{"type":"bold"}]}]}]),
    );
    let c = repo.connection.lock().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT before_hash FROM history_entries WHERE position=5",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        first_after
    );
    assert_eq!(
        c.query_row(
            "SELECT label FROM history_entries WHERE position=5",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "edit"
    );
}

#[test]
fn reopened_session_cannot_resume_an_interrupted_group_but_old_receipt_replays() {
    let (dir, repo, project) = setup();
    let b = id();
    let edit = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&b,"Acknowledged"),"after":null}]),
        json!([]),
    );
    let receipt = repo.execute_manuscript(&edit).unwrap();
    let state = repo.read_manuscript().unwrap();
    drop(repo);
    let repo = SqliteProjectRepository::open(dir.path()).unwrap();
    assert_eq!(repo.read_manuscript().unwrap(), state);
    assert_eq!(
        repo.read_history().unwrap().history_revision,
        receipt.history_revision + 1
    );
    assert_eq!(repo.execute_manuscript(&edit).unwrap(), receipt);
    let mut continuation = serde_json::to_value(edit).unwrap();
    continuation["requestId"] = json!(id());
    continuation["expectedWorkingRevision"] = json!(state.working_revision);
    continuation["payload"]["operations"] = json!([]);
    continuation["payload"]["expectedBlockRevisions"] = json!([]);
    continuation["payload"]["group"]["groupSequence"] = json!(2);
    let before = repo.read_history().unwrap();
    assert_eq!(
        repo.execute_manuscript(&serde_json::from_value(continuation).unwrap())
            .unwrap_err()
            .0,
        "INVALID_REQUEST"
    );
    assert_eq!(repo.read_history().unwrap(), before);
}
#[test]
fn closing_group_preserves_exact_history_roots_and_uses_only_compact_metadata() {
    let (_dir, repo, project) = setup();
    let block_id = id();
    let edit = command(
        &project,
        1,
        json!([{"op":"insertBlock","block":block(&block_id,"group body"),"after":null}]),
        json!([]),
    );
    let receipt = repo.execute_manuscript(&edit).unwrap();
    let before = repo.read_manuscript().unwrap();
    let rows = |repo: &SqliteProjectRepository| {
        let c = repo.connection.lock().unwrap();
        let mut q=c.prepare("SELECT h.before_hash,h.after_hash,i.entry_id FROM history_entries h JOIN history_entry_identities i USING(position) ORDER BY position").unwrap();
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap()
    };
    let roots = rows(&repo);
    let payload = if let ManuscriptCommand::ApplyDocumentEdit { payload, .. } = &edit {
        json!({"clientSessionId":payload.group.client_session_id,"groupId":payload.group.group_id,"groupSequence":payload.group.group_sequence})
    } else {
        unreachable!()
    };
    let close:ManuscriptCommand=serde_json::from_value(json!({"type":"CloseEditGroup","requestId":id(),"projectId":project,"expectedWorkingRevision":receipt.working_revision,"expectedHistoryRevision":receipt.history_revision,"expectedCursor":receipt.cursor,"payload":payload})).unwrap();
    repo.business_read_count
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let closed = repo.execute_manuscript(&close).unwrap();
    assert_eq!(
        repo.business_read_count
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
    assert_eq!(closed.working_revision, receipt.working_revision);
    assert_eq!(closed.history_revision, receipt.history_revision + 1);
    assert_eq!(rows(&repo), roots);
    assert_eq!(repo.read_manuscript().unwrap(), before);
    assert_eq!(repo.execute_manuscript(&close).unwrap(), closed);
}
