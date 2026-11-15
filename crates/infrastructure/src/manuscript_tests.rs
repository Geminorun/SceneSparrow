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
            Err(ManuscriptError("CONTENT_LOCKED"))
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
                Err(ManuscriptError("TASK_USING_CONTENT"))
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
        c.query_row("SELECT COUNT(*) FROM project_events", [], |r| r
            .get::<_, i64>(0))
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
