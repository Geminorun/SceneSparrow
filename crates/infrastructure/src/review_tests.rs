use super::*;
use crate::ai::settings::SettingsStore;
use scenesparrow_application::{ProjectRepository, manuscript::ManuscriptRepository};
use serde_json::{Value, json};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn cmd(r: &SqliteProjectRepository, p: &str, name: &str, payload: Value) -> ManuscriptCommand {
    serde_json::from_value(json!({"type":name,"requestId":id(),"projectId":p,"expectedWorkingRevision":r.read_manuscript().unwrap().working_revision,"payload":payload})).unwrap()
}
fn setup() -> (
    tempfile::TempDir,
    SqliteProjectRepository,
    SettingsStore,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    let p = r.create("fixture", "Review 中文").unwrap().id;
    let s = SettingsStore::open(&dir.path().join("app")).unwrap();
    crate::ai::tests::configured(&s, "none");
    let start = cmd(&r, &p, "StartManualDraft", json!({}));
    r.execute_manuscript(&start).unwrap();
    let b = id();
    edit(
        &r,
        &p,
        json!([{"op":"insertBlock","after":null,"block":{"id":b,"kind":"paragraph","attrs":{},"runs":[{"text":"hello 🐦 é 中文","marks":[{"type":"bold"}]}]}}]),
    );
    (dir, r, s, p)
}
fn edit(r: &SqliteProjectRepository, p: &str, ops: Value) -> CommandReceipt {
    let revs = r
        .read_manuscript()
        .unwrap()
        .blocks
        .iter()
        .map(|b| json!({"id":b.id,"revision":b.revision}))
        .collect::<Vec<_>>();
    r.execute_manuscript(&cmd(r,p,"ApplyDocumentEdit",json!({"operations":ops,"expectedBlockRevisions":revs,"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap()
}
fn note(r: &SqliteProjectRepository, p: &str, question: bool, index: usize) -> String {
    let state = r.read_manuscript().unwrap();
    let b = &state.blocks[index];
    let text = review::text(b);
    let thread = id();
    r.execute_manuscript(&cmd(r,p,"SaveReview",json!({"expectedRequestVersion":0,"thread":{"id":thread,"kind":if question{"question"}else{"revision_note"},"requestVersion":0,"text":"Explain / improve","anchor":{"ranges":[{"blockId":b.id,"revision":b.revision,"start":0,"end":text.encode_utf16().count(),"quote":text,"wholeBlock":true}],"state":"mapped","slot":null},"handled":false,"deleted":false,"language":"zh-CN","evidence":[],"decision":null,"userMessageIds":[]}}))).unwrap();
    thread
}
fn start(r: &SqliteProjectRepository, s: &SettingsStore, p: &str, t: &str) -> String {
    let command = cmd(
        r,
        p,
        "StartReviewTask",
        json!({"threadId":t,"requestVersion":1}),
    );
    r.start_review(s, &command).unwrap();
    manuscript::envelope(&command).0.into()
}
fn complete(r: &SqliteProjectRepository, v: Value) {
    let (run, fence) = r.claim_ai().unwrap().unwrap();
    r.dispatch_ai(&run.run_id, run.attempt, &fence, &run.input_hash)
        .unwrap();
    let bytes = serde_json::to_vec(&v).unwrap();
    r.complete_ai(
        &AiCompletion {
            run_id: run.run_id,
            attempt: run.attempt,
            fence,
            input_hash: run.input_hash,
            output_hash: hash(&bytes),
            finish_reason: AiCompletionFinishReason::Stop,
            usage: None,
        },
        &bytes,
    )
    .unwrap();
}
fn proposal() -> Value {
    json!({"schemaVersion":1,"explanation":"Scoped improvement","mode":"replace_ranges","replacements":[{"rangeIndex":0,"runs":[{"text":"Better 中文 🐦","marks":[]}]}]})
}
fn candidate(r: &SqliteProjectRepository, t: &str) -> ReviewCandidate {
    r.read_reviews(None)
        .unwrap()
        .cards
        .into_iter()
        .find(|c| c.thread.id == t)
        .unwrap()
        .candidate
        .unwrap()
}
fn accept(r: &SqliteProjectRepository, p: &str, cs: &[ReviewCandidate]) -> ManuscriptCommand {
    cmd(
        r,
        p,
        "AcceptReviewCandidates",
        json!({"expectedHistoryRevision":r.read_history().unwrap().history_revision,"candidates":cs.iter().map(|c|json!({"id":c.id,"version":c.version})).collect::<Vec<_>>()}),
    )
}
#[test]
fn manual_draft_question_save_has_no_run_and_answer_is_read_only() {
    let (_d, r, s, p) = setup();
    let before = r.read_manuscript().unwrap().blocks;
    let t = note(&r, &p, true, 0);
    assert!(!r.has_queued_ai().unwrap());
    let history = r.read_history().unwrap();
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Explanation 中文","evidenceReferences":[]}),
    );
    r.reconcile_reviews().unwrap();
    let card = r.read_reviews(None).unwrap().cards.remove(0);
    assert_eq!(
        card.task.unwrap().answer.as_deref(),
        Some("Explanation 中文")
    );
    assert!(!card.thread.handled);
    assert_eq!(r.read_manuscript().unwrap().blocks, before);
    assert_eq!(r.read_history().unwrap(), history);
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"hack","evidenceReferences":[],"patch":[],"handled":true}),
    );
    r.reconcile_reviews().unwrap();
    assert_eq!(r.read_manuscript().unwrap().blocks, before);
    assert_eq!(
        r.read_reviews(None).unwrap().cards[0]
            .task
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("INVALID_OUTPUT")
    );
}
#[test]
fn revision_claim_reservation_accept_replay_and_no_lock() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    let other = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    assert_eq!(
        r.start_review(
            &s,
            &cmd(
                &r,
                &p,
                "StartReviewTask",
                json!({"threadId":other,"requestVersion":1})
            )
        )
        .unwrap_err()
        .0,
        "CANDIDATE_CLAIMED"
    );
    let state = r.read_manuscript().unwrap();
    let blocked = cmd(
        &r,
        &p,
        "ApplyDocumentEdit",
        json!({"operations":[{"op":"setBlockContent","id":state.blocks[0].id,"runs":[]}],"expectedBlockRevisions":[{"id":state.blocks[0].id,"revision":state.blocks[0].revision}],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    );
    assert_eq!(
        r.execute_manuscript(&blocked).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    let h = r.read_history().unwrap();
    let command = accept(&r, &p, &[c]);
    let receipt = r.execute_manuscript(&command).unwrap();
    assert_eq!(receipt.history_revision, h.history_revision + 1);
    assert_eq!(r.execute_manuscript(&command).unwrap(), receipt);
    assert_eq!(
        review::text(&r.read_manuscript().unwrap().blocks[0]),
        "Better 中文 🐦"
    );
    assert!(
        r.read_reviews(None)
            .unwrap()
            .cards
            .iter()
            .find(|c| c.thread.id == t)
            .unwrap()
            .thread
            .handled
    );
}
#[test]
fn unchanged_regeneration_no_change_and_failure_preserve_candidate() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"explanation":"Scoped improvement","mode":"replace_ranges","replacements":[{"rangeIndex":0,"runs":r.read_manuscript().unwrap().blocks[0].runs}]}),
    );
    r.reconcile_reviews().unwrap();
    assert_eq!(candidate(&r, &t).id, c.id);
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"explanation":"Scoped improvement","mode":"replace_ranges","replacements":[],"unlock":true}),
    );
    r.reconcile_reviews().unwrap();
    assert_eq!(candidate(&r, &t).id, c.id);
}
#[test]
fn source_change_stales_and_discard_regeneration_must_wait() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    start(&r, &s, &p, &t);
    assert_eq!(
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "DiscardReviewCandidate",
            json!({"candidate":{"id":c.id,"version":c.version}})
        ))
        .unwrap_err()
        .0,
        "REVIEW_TASK_ACTIVE"
    );
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "CancelReviewTask",
        json!({"threadId":t,"requestVersion":1}),
    ))
    .unwrap();
    let b = r.read_manuscript().unwrap().blocks[0].clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":b.id,"runs":[{"text":"Manual edit","marks":[]}]}]),
    );
    let c = candidate(&r, &t);
    assert_eq!(c.status, "stale");
    assert_eq!(
        r.execute_manuscript(&accept(&r, &p, std::slice::from_ref(&c)))
            .unwrap_err()
            .0,
        "CANDIDATE_STALE"
    );
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DiscardReviewCandidate",
        json!({"candidate":{"id":c.id,"version":c.version}}),
    ))
    .unwrap();
    assert_eq!(
        review::text(&r.read_manuscript().unwrap().blocks[0]),
        "Manual edit"
    );
}
#[test]
fn result_persisted_then_reopened_is_projected_once_without_paid_work() {
    let (d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    let run = start(&r, &s, &p, &t);
    complete(&r, proposal());
    drop(r);
    let r = SqliteProjectRepository::open(&d.path().join("project")).unwrap();
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    assert_eq!(c.run_id, run);
    r.reconcile_reviews().unwrap();
    assert_eq!(candidate(&r, &t).id, c.id);
    assert!(!r.has_queued_ai().unwrap());
}
#[test]
fn atomic_exact_set_batch_rejects_stale_without_partial_changes() {
    let (_d, r, s, p) = setup();
    let b = id();
    edit(
        &r,
        &p,
        json!([{"op":"insertBlock","after":r.read_manuscript().unwrap().blocks.last().unwrap().id,"block":{"id":b,"kind":"paragraph","attrs":{},"runs":[{"text":"Second","marks":[]}]}}]),
    );
    let a = note(&r, &p, false, 0);
    let b = note(&r, &p, false, 1);
    start(&r, &s, &p, &a);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    start(&r, &s, &p, &b);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let ca = candidate(&r, &a);
    let cb = candidate(&r, &b);
    let target = r.read_manuscript().unwrap().blocks[1].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":target,"runs":[{"text":"Changed","marks":[]}]}]),
    );
    let before = r.read_manuscript().unwrap();
    let h = r.read_history().unwrap();
    assert_eq!(
        r.execute_manuscript(&accept(&r, &p, &[ca.clone(), cb]))
            .unwrap_err()
            .0,
        "CANDIDATE_STALE"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(r.read_history().unwrap(), h);
    r.execute_manuscript(&accept(&r, &p, &[ca])).unwrap();
    assert_eq!(
        review::text(&r.read_manuscript().unwrap().blocks[1]),
        "Changed"
    );
}
fn history(r: &SqliteProjectRepository, p: &str, redo: bool) {
    let h = r.read_history().unwrap();
    let command:ManuscriptCommand=serde_json::from_value(json!({"type":if redo{"RedoProject"}else{"UndoProject"},"requestId":id(),"projectId":p,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap();
    r.execute_manuscript(&command).unwrap();
}
#[test]
fn mapped_anchor_prefix_edit_undo_redo_reopen_matches_history_once() {
    let (d, r, _s, p) = setup();
    let b = r.read_manuscript().unwrap().blocks[0].clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":b.id,"runs":[{"text":"abc TARGET xyz","marks":[]}]}]),
    );
    let b = r.read_manuscript().unwrap().blocks[0].clone();
    let t = note(&r, &p, true, 0);
    let mut thread = SelfThread::get(&r, &t);
    thread.anchor.ranges[0].start = 4;
    thread.anchor.ranges[0].end = 10;
    thread.anchor.ranges[0].whole_block = false;
    thread.anchor.ranges[0].quote = "TARGET".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":1}),
    ))
    .unwrap();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":b.id,"runs":[{"text":"Qabc TARGET xyz","marks":[]}]}]),
    );
    assert_eq!(SelfThread::get(&r, &t).anchor.ranges[0].start, 5);
    history(&r, &p, false);
    assert_eq!(SelfThread::get(&r, &t).anchor.ranges[0].start, 4);
    history(&r, &p, true);
    assert_eq!(SelfThread::get(&r, &t).anchor.ranges[0].start, 5);
    drop(r);
    let r = SqliteProjectRepository::open(&d.path().join("project")).unwrap();
    assert_eq!(SelfThread::get(&r, &t).anchor.ranges[0].start, 5);
}
struct SelfThread;
impl SelfThread {
    fn get(r: &SqliteProjectRepository, id: &str) -> ReviewThread {
        r.read_reviews(None)
            .unwrap()
            .cards
            .into_iter()
            .find(|c| c.thread.id == id)
            .unwrap()
            .thread
    }
}
#[test]
fn selected_nested_list_item_scoped_output_preserves_full_structure() {
    let (_d, r, s, p) = setup();
    let parent = id();
    let nested = id();
    let first = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"insertBlock","after":first,"block":{"id":parent,"kind":"list_item","attrs":{"listKind":"bullet","depth":0},"runs":[{"text":"Parent","marks":[]}]}},{"op":"insertBlock","after":parent,"block":{"id":nested,"kind":"list_item","attrs":{"listKind":"bullet","depth":1},"runs":[{"text":"Nested","marks":[]}]}}]),
    );
    let t = note(&r, &p, false, 2);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    r.execute_manuscript(&accept(&r, &p, &[c])).unwrap();
    let state = r.read_manuscript().unwrap();
    assert_eq!(state.blocks[2].attrs.depth, Some(1));
    assert_eq!(review::text(&state.blocks[1]), "Parent");
}
#[test]
fn no_op_review_save_preserves_candidate_redo_and_request_identity() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let candidate = candidate(&r, &t);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"Unrelated"}),
    ))
    .unwrap();
    history(&r, &p, false);
    let h = r.read_history().unwrap();
    let thread = SelfThread::get(&r, &t);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":thread.request_version}),
    ))
    .unwrap();
    assert_eq!(r.read_history().unwrap(), h);
    assert_eq!(
        SelfThread::get(&r, &t).request_version,
        thread.request_version
    );
    assert_eq!(self::candidate(&r, &t).id, candidate.id);
    assert_eq!(self::candidate(&r, &t).status, "pending");
}
#[test]
fn shared_source_comparison_survives_handling_one_owner_and_clears_last_reference() {
    let (_d, r, _s, p) = setup();
    let a = note(&r, &p, true, 0);
    let b = note(&r, &p, true, 0);
    let block = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":block,"runs":[{"text":"Changed manually","marks":[]}]}]),
    );
    let cards = r.read_reviews(None).unwrap().cards;
    assert_eq!(
        cards
            .iter()
            .find(|c| c.thread.id == b)
            .unwrap()
            .source_comparisons
            .len(),
        1
    );
    for id in [a, b.clone()] {
        let thread = SelfThread::get(&r, &id);
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "SetReviewHandled",
            json!({"threadId":id,"requestVersion":thread.request_version,"handled":true}),
        ))
        .unwrap();
        if id != b {
            assert_eq!(
                r.read_reviews(None)
                    .unwrap()
                    .cards
                    .iter()
                    .find(|c| c.thread.id == b)
                    .unwrap()
                    .source_comparisons
                    .len(),
                1
            );
        }
    }
    assert!(
        r.read_reviews(None)
            .unwrap()
            .cards
            .iter()
            .all(|c| c.source_comparisons.is_empty())
    );
}
#[test]
fn answer_arrives_with_redo_tail_and_followup_visibility_is_business_state() {
    let (d, r, s, p) = setup();
    let t = note(&r, &p, true, 0);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"Unrelated"}),
    ))
    .unwrap();
    history(&r, &p, false);
    let h = r.read_history().unwrap();
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Original answer","evidenceReferences":[]}),
    );
    r.reconcile_reviews().unwrap();
    assert_eq!(r.read_history().unwrap(), h);
    history(&r, &p, true);
    history(&r, &p, false);
    assert_eq!(r.review_messages(&t, None).unwrap().messages.len(), 2);
    let mut thread = SelfThread::get(&r, &t);
    thread.text = "Follow-up question".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"expectedRequestVersion":thread.request_version,"thread":thread}),
    ))
    .unwrap();
    assert_eq!(r.review_messages(&t, None).unwrap().messages.len(), 3);
    assert!(
        r.read_reviews(None).unwrap().cards[0]
            .task
            .as_ref()
            .unwrap()
            .answer
            .is_none()
    );
    history(&r, &p, false);
    let messages = r.review_messages(&t, None).unwrap().messages;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].request_version, 1);
    assert_ne!(SelfThread::get(&r, &t).request_version, 1);
    drop(r);
    let r = SqliteProjectRepository::open(&d.path().join("project")).unwrap();
    assert_eq!(r.review_messages(&t, None).unwrap().messages.len(), 2);
    assert!(!r.has_queued_ai().unwrap());
}
#[test]
fn cancel_and_delete_origin_watermarks_fence_restored_queued_work() {
    for delete in [false, true] {
        let (d, r, s, p) = setup();
        let t = note(&r, &p, false, 0);
        let command = cmd(
            &r,
            &p,
            "StartReviewTask",
            json!({"threadId":t,"requestVersion":1}),
        );
        r.start_review(&s, &command).unwrap();
        let run = manuscript::envelope(&command).0.to_owned();
        let receipt = r.command_receipt(&run).unwrap();
        let backup = d.path().join("before-review-fence.sqlite");
        r.connection
            .lock()
            .unwrap()
            .backup(rusqlite::DatabaseName::Main, &backup, None)
            .unwrap();
        let fence = if delete {
            cmd(
                &r,
                &p,
                "DeleteReviewThread",
                json!({"threadId":t,"requestVersion":1,"discardCandidate":false}),
            )
        } else {
            cmd(
                &r,
                &p,
                "CancelReviewTask",
                json!({"threadId":t,"requestVersion":1}),
            )
        };
        r.execute_manuscript(&fence).unwrap();
        drop(r);
        std::fs::write(
            d.path().join("project/project.sqlite"),
            std::fs::read(backup).unwrap(),
        )
        .unwrap();
        let r = SqliteProjectRepository::open(&d.path().join("project")).unwrap();
        r.reconcile_reviews().unwrap();
        assert_eq!(r.read_run(&run).unwrap().status, AiRunStatus::Interrupted);
        assert!(!r.has_queued_ai().unwrap());
        assert_eq!(r.start_review(&s, &command).unwrap(), receipt);
        assert_eq!(
            r.connection
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM review_reservations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
#[test]
fn fill_slot_has_structural_reservation_and_closed_depth_validation() {
    let (_d, r, s, p) = setup();
    let heading = id();
    let boundary = id();
    let first = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"insertBlock","after":first,"block":{"id":heading,"kind":"heading","attrs":{"level":1},"runs":[{"text":"Empty section","marks":[]}]}},{"op":"insertBlock","after":heading,"block":{"id":boundary,"kind":"heading","attrs":{"level":1},"runs":[{"text":"Next section","marks":[]}]}}]),
    );
    let t = note(&r, &p, false, 1);
    let mut thread = SelfThread::get(&r, &t);
    thread.anchor.slot = Some(ReviewSlot {
        heading_id: heading.clone(),
        before_id: heading.clone(),
        after_id: Some(boundary.clone()),
    });
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"expectedRequestVersion":1,"thread":thread}),
    ))
    .unwrap();
    let start_command = cmd(
        &r,
        &p,
        "StartReviewTask",
        json!({"threadId":t,"requestVersion":2}),
    );
    r.start_review(&s, &start_command).unwrap();
    let insertion = cmd(
        &r,
        &p,
        "ApplyDocumentEdit",
        json!({"operations":[{"op":"insertBlock","after":heading,"block":{"id":id(),"kind":"paragraph","attrs":{},"runs":[]}}],"expectedBlockRevisions":[],"group":{"groupId":id(),"clientSessionId":id(),"groupSequence":1,"kind":"discrete"}}),
    );
    assert_eq!(
        r.execute_manuscript(&insertion).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    complete(
        &r,
        json!({"schemaVersion":1,"mode":"fill_section","explanation":"Bad nested first item","blocks":[{"kind":"list_item","attrs":{"listKind":"bullet","depth":3},"runs":[{"text":"bad","marks":[]}]}]}),
    );
    r.reconcile_reviews().unwrap();
    assert!(
        r.read_reviews(None)
            .unwrap()
            .cards
            .iter()
            .find(|c| c.thread.id == t)
            .unwrap()
            .candidate
            .is_none()
    );
    r.start_review(
        &s,
        &cmd(
            &r,
            &p,
            "StartReviewTask",
            json!({"threadId":t,"requestVersion":2}),
        ),
    )
    .unwrap();
    complete(
        &r,
        json!({"schemaVersion":1,"mode":"fill_section","explanation":"Fill empty section","blocks":[{"kind":"paragraph","attrs":{},"runs":[{"text":"Inserted only","marks":[]}]}]}),
    );
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    let fresh = c.after[1].id.clone();
    r.execute_manuscript(&accept(&r, &p, &[c])).unwrap();
    let state = r.read_manuscript().unwrap();
    assert_eq!(state.blocks[2].id, fresh);
    assert_eq!(state.blocks[3].id, boundary);
    assert!(SelfThread::get(&r, &t).handled);
}
#[test]
fn successful_exact_set_batch_is_one_history_step_excludes_later_arrival_and_replays() {
    let (_d, r, s, p) = setup();
    let mut after = r.read_manuscript().unwrap().blocks[0].id.clone();
    for name in ["second", "third"] {
        let b = id();
        edit(
            &r,
            &p,
            json!([{"op":"insertBlock","after":after,"block":{"id":b,"kind":"paragraph","attrs":{},"runs":[{"text":name,"marks":[]}]}}]),
        );
        after = b;
    }
    let a = note(&r, &p, false, 0);
    let b = note(&r, &p, false, 1);
    let c = note(&r, &p, false, 2);
    for t in [&a, &b] {
        start(&r, &s, &p, t);
        complete(&r, proposal());
        r.reconcile_reviews().unwrap();
    }
    let submitted = vec![candidate(&r, &a), candidate(&r, &b)];
    start(&r, &s, &p, &c);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let h = r.read_history().unwrap();
    let command = accept(&r, &p, &submitted);
    let receipt = r.execute_manuscript(&command).unwrap();
    assert_eq!(receipt.history_revision, h.history_revision + 1);
    assert_eq!(r.execute_manuscript(&command).unwrap(), receipt);
    assert_eq!(candidate(&r, &c).status, "pending");
    let body = r.read_manuscript().unwrap().blocks;
    history(&r, &p, false);
    assert_ne!(r.read_manuscript().unwrap().blocks[0].runs, body[0].runs);
    history(&r, &p, true);
    assert_eq!(r.read_manuscript().unwrap().blocks[0].runs, body[0].runs);
}
#[test]
fn typed_no_change_is_distinct_from_invalid_and_keeps_previous_comparison() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let original = candidate(&r, &t);
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"mode":"replace_ranges","explanation":"Already suitable","replacements":[{"rangeIndex":0,"runs":r.read_manuscript().unwrap().blocks[0].runs}]}),
    );
    r.reconcile_reviews().unwrap();
    let card = r
        .read_reviews(None)
        .unwrap()
        .cards
        .into_iter()
        .find(|c| c.thread.id == t)
        .unwrap();
    assert_eq!(card.task.unwrap().application, "no_change");
    assert_eq!(card.candidate.unwrap().id, original.id);
}
#[test]
fn restored_request_answers_keep_alias_visibility_and_unchanged_thread_tasks_continue() {
    let (_d, r, s, p) = setup();
    let a = note(&r, &p, true, 0);
    let b = note(&r, &p, true, 0);
    start(&r, &s, &p, &b);
    let mut thread = SelfThread::get(&r, &a);
    thread.text = "Changed A only".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":1}),
    ))
    .unwrap();
    history(&r, &p, false);
    assert_eq!(SelfThread::get(&r, &b).request_version, 1);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Independent B","evidenceReferences":[]}),
    );
    r.reconcile_reviews().unwrap();
    assert_eq!(
        r.read_reviews(None)
            .unwrap()
            .cards
            .iter()
            .find(|c| c.thread.id == b)
            .unwrap()
            .answer
            .as_ref()
            .unwrap()
            .text,
        "Independent B"
    );
    let restored = SelfThread::get(&r, &a);
    r.start_review(
        &s,
        &cmd(
            &r,
            &p,
            "StartReviewTask",
            json!({"threadId":a,"requestVersion":restored.request_version}),
        ),
    )
    .unwrap();
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Restored A answer","evidenceReferences":[]}),
    );
    r.reconcile_reviews().unwrap();
    let messages = r.review_messages(&a, None).unwrap().messages;
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].request_version, restored.request_version);
    assert_eq!(messages[1].request_user_id, messages[0].id);
}
#[test]
fn answer_provenance_survives_failed_regeneration_and_pruning() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, true, 0);
    let first = start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Keep A","evidenceReferences":[]}),
    );
    r.reconcile_reviews().unwrap();
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"answer":"Invalid B","evidenceReferences":[],"patch":[]}),
    );
    r.reconcile_reviews().unwrap();
    r.prune_review_payloads().unwrap();
    let card = r.read_reviews(None).unwrap().cards.remove(0);
    assert_ne!(card.task.as_ref().unwrap().run.run_id, first);
    assert!(card.task.unwrap().answer.is_none());
    assert_eq!(card.answer.as_ref().unwrap().run_id, first);
    assert_eq!(card.answer.unwrap().text, "Keep A");
    assert!(r.read_result(&first).unwrap().is_some());
}
#[test]
fn large_quotes_are_deduplicated_immutable_references_in_sql_and_history() {
    let (d, r, _s, p) = setup();
    let b = r.read_manuscript().unwrap().blocks[0].id.clone();
    let text = "中".repeat(22000);
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":b,"runs":[{"text":text,"marks":[]}]}]),
    );
    let a = note(&r, &p, true, 0);
    let b = note(&r, &p, true, 0);
    let c = r.connection.lock().unwrap();
    let rows = SqliteProjectRepository::review_threads(&c).unwrap();
    assert!(rows.iter().all(|t| t.anchor.ranges[0].quote.is_empty()));
    let hash = rows[0].anchor.ranges[0].quote_hash.clone().unwrap();
    assert_eq!(rows[1].anchor.ranges[0].quote_hash.as_ref(), Some(&hash));
    assert!(
        c.query_row(
            "SELECT MAX(length(user_json)) FROM review_threads",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            < 2048
    );
    drop(c);
    assert_eq!(SelfThread::get(&r, &a).anchor.ranges[0].quote, text);
    assert_eq!(SelfThread::get(&r, &b).anchor.ranges[0].quote, text);
    assert!(r.retained_object_roots().unwrap().contains(&hash));
    drop(r);
    let r = SqliteProjectRepository::open(&d.path().join("project")).unwrap();
    assert_eq!(SelfThread::get(&r, &a).anchor.ranges[0].quote, text);
}
#[test]
fn large_candidate_cards_use_preview_and_explicit_bounded_detail_pages() {
    let (_d, r, s, p) = setup();
    let b = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":b,"runs":[{"text":"a".repeat(450000),"marks":[]}]}]),
    );
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    let runs = (0..90000)
        .map(|i| json!({"text":"x","marks":[{"type":if i%2==0{"bold"}else{"italic"}}]}))
        .collect::<Vec<_>>();
    complete(
        &r,
        json!({"schemaVersion":1,"mode":"replace_ranges","explanation":"Large but bounded formatting proposal","replacements":[{"rangeIndex":0,"runs":runs}]}),
    );
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    assert!(c.preview_truncated);
    let first = r.review_candidate(&c.id, 0).unwrap();
    assert!(serde_json::to_vec(&first).unwrap().len() < 4 * 1024 * 1024 + 4096);
    let next = first.detail_next_cursor.unwrap();
    let last = r.review_candidate(&c.id, next as usize).unwrap();
    assert!(last.detail_next_cursor.is_none());
    assert!(serde_json::to_vec(&last).unwrap().len() < 4 * 1024 * 1024 + 4096);
}
#[test]
fn changed_instruction_failure_cannot_resurrect_prior_candidate_and_noop_at_message_cap() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let original = candidate(&r, &t);
    let mut thread = SelfThread::get(&r, &t);
    thread.text = "New instruction".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":1}),
    ))
    .unwrap();
    assert_eq!(candidate(&r, &t).status, "stale");
    r.start_review(
        &s,
        &cmd(
            &r,
            &p,
            "StartReviewTask",
            json!({"threadId":t,"requestVersion":2}),
        ),
    )
    .unwrap();
    complete(&r, json!({"schemaVersion":1,"patch":[]}));
    r.reconcile_reviews().unwrap();
    assert_eq!(candidate(&r, &t).id, original.id);
    assert_eq!(candidate(&r, &t).status, "stale");
    let thread = SelfThread::get(&r, &t);
    {
        let c = r.connection.lock().unwrap();
        for n in 0..198 {
            c.execute("INSERT INTO review_messages(id,thread_id,request_version,author,text,request_user_id) VALUES(?1,?2,?3,'user',?4,?5)",params![id(),t,thread.request_version,format!("retained {n}"),thread.user_message_ids[0]]).unwrap();
        }
    }
    let h = r.read_history().unwrap();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":thread.request_version}),
    ))
    .unwrap();
    assert_eq!(r.read_history().unwrap(), h);
    let mut changed = thread.clone();
    changed.text = "At capacity".into();
    assert_eq!(
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "SaveReview",
            json!({"thread":changed,"expectedRequestVersion":thread.request_version})
        ))
        .unwrap_err()
        .0,
        "DOCUMENT_TOO_LARGE"
    );
}
#[test]
fn decision_storage_fault_rolls_back_and_policy_rechecks_actual_acceptance_diff() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let c = candidate(&r, &t);
    let command = accept(&r, &p, std::slice::from_ref(&c));
    let before = r.read_manuscript().unwrap();
    let history = r.read_history().unwrap();
    r.connection.lock().unwrap().execute_batch("CREATE TRIGGER reject_review_decision BEFORE INSERT ON review_decisions BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert_eq!(
        r.execute_manuscript(&command).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(r.read_history().unwrap(), history);
    assert_eq!(candidate(&r, &t).status, "pending");
    r.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_review_decision")
        .unwrap();
    struct AtCommit(std::sync::atomic::AtomicUsize);
    impl manuscript::MutationPolicy for AtCommit {
        fn validate(
            &self,
            _: &ManuscriptState,
            _: &ManuscriptState,
            _: &BTreeSet<String>,
        ) -> Result<()> {
            if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 2 {
                Err(ManuscriptError("CONTENT_LOCKED", None))
            } else {
                Ok(())
            }
        }
    }
    let r = r.with_policy(std::sync::Arc::new(AtCommit(
        std::sync::atomic::AtomicUsize::new(0),
    )));
    assert_eq!(
        r.execute_manuscript(&command).unwrap_err().0,
        "CONTENT_LOCKED"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(candidate(&r, &t).status, "pending");
    assert_eq!(
        r.execute_manuscript(&command).unwrap_err().0,
        "CONTENT_LOCKED"
    );
}
#[test]
fn deleted_thread_fences_late_result_and_question_cannot_claim_an_insertion_slot() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, true, 0);
    let mut invalid = SelfThread::get(&r, &t);
    invalid.anchor.slot = Some(ReviewSlot {
        heading_id: invalid.anchor.ranges[0].block_id.clone(),
        before_id: invalid.anchor.ranges[0].block_id.clone(),
        after_id: None,
    });
    assert_eq!(
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "SaveReview",
            json!({"thread":invalid,"expectedRequestVersion":1})
        ))
        .unwrap_err()
        .0,
        "ANCHOR_INVALID"
    );
    start(&r, &s, &p, &t);
    let (run, fence) = r.claim_ai().unwrap().unwrap();
    r.dispatch_ai(&run.run_id, run.attempt, &fence, &run.input_hash)
        .unwrap();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DeleteReviewThread",
        json!({"threadId":t,"requestVersion":1,"discardCandidate":false}),
    ))
    .unwrap();
    let bytes =
        serde_json::to_vec(&json!({"schemaVersion":1,"answer":"Too late","evidenceReferences":[]}))
            .unwrap();
    let result = r.complete_ai(
        &AiCompletion {
            run_id: run.run_id,
            attempt: run.attempt,
            fence,
            input_hash: run.input_hash,
            output_hash: hash(&bytes),
            finish_reason: AiCompletionFinishReason::Stop,
            usage: None,
        },
        &bytes,
    );
    assert!(result.is_err());
    r.reconcile_reviews().unwrap();
    assert!(r.read_reviews(None).unwrap().cards.is_empty());
    assert!(r.review_messages(&t, None).is_err());
}
#[test]
fn superseded_unreferenced_revision_payloads_are_pruned_but_current_candidate_stays_rooted() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    let first = start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let old = candidate(&r, &t);
    start(&r, &s, &p, &t);
    complete(
        &r,
        json!({"schemaVersion":1,"mode":"replace_ranges","explanation":"Second candidate","replacements":[{"rangeIndex":0,"runs":[{"text":"Second proposal","marks":[]}]}]}),
    );
    r.reconcile_reviews().unwrap();
    let current = candidate(&r, &t);
    let h = r.read_history().unwrap();
    r.prune_review_payloads().unwrap();
    assert_eq!(candidate(&r, &t).id, current.id);
    assert_eq!(r.read_history().unwrap(), h);
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert_eq!(r.read_result(&first).unwrap_err().0, "RESULT_UNAVAILABLE");
    let c = r.connection.lock().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT context_hash FROM review_tasks WHERE run_id=?1",
            [&first],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        ""
    );
    assert!(
        c.query_row(
            "SELECT payload_hash FROM review_candidates WHERE id=?1",
            [old.id],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap()
        .is_none()
    );
}
#[test]
fn migration007_failure_keeps_verified_unique_backup_then_retries_without_rewriting_objects() {
    let (d, r, _s, _p) = setup();
    let before = r.read_manuscript().unwrap();
    let roots = r.retained_object_roots().unwrap();
    let bytes = roots
        .iter()
        .map(|h| (h.clone(), r.read_object(h).unwrap()))
        .collect::<BTreeMap<_, _>>();
    drop(r);
    let path = d.path().join("project");
    let c = Connection::open(path.join("project.sqlite")).unwrap();
    c.execute_batch("DROP TABLE history_entry_identities;DROP TABLE review_messages;DROP TABLE review_decisions;DROP TABLE review_comparisons;DROP TABLE review_reservations;DROP TABLE review_claims;DROP TABLE review_candidates;DROP TABLE review_tasks;DROP TABLE review_threads;PRAGMA user_version=6;CREATE TABLE review_threads(conflict INTEGER);").unwrap();
    drop(c);
    assert!(SqliteProjectRepository::open(&path).is_err());
    let backups = std::fs::read_dir(&path)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pre-migration-007-")
        })
        .collect::<Vec<_>>();
    let c = Connection::open(path.join("project.sqlite")).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    c.execute_batch("DROP TABLE review_threads").unwrap();
    drop(c);
    let r = SqliteProjectRepository::open(&path).unwrap();
    assert_eq!(r.read_manuscript().unwrap(), before);
    for (h, original) in bytes {
        assert_eq!(r.read_object(&h).unwrap(), original);
    }
    assert!(
        backups
            .iter()
            .all(|b| b.join("project.sqlite").exists() && b.join("objects").is_dir())
    );
}
#[test]
fn discarding_stale_candidate_reveals_only_latest_shared_manual_comparison() {
    let (_d, r, s, p) = setup();
    let a = note(&r, &p, false, 0);
    let b = note(&r, &p, true, 0);
    start(&r, &s, &p, &a);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let block = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":block,"runs":[{"text":"Latest manual source","marks":[]}]}]),
    );
    let c = candidate(&r, &a);
    assert!(
        r.read_reviews(None)
            .unwrap()
            .cards
            .iter()
            .find(|c| c.thread.id == b)
            .unwrap()
            .source_comparisons
            .is_empty()
    );
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DiscardReviewCandidate",
        json!({"candidate":{"id":c.id,"version":c.version}}),
    ))
    .unwrap();
    let cards = r.read_reviews(None).unwrap().cards;
    let pair = &cards
        .iter()
        .find(|c| c.thread.id == b)
        .unwrap()
        .source_comparisons[0];
    assert_eq!(
        review::text(pair.after.as_ref().unwrap()),
        "Latest manual source"
    );
    assert!(
        cards
            .iter()
            .find(|c| c.thread.id == a)
            .unwrap()
            .candidate
            .is_none()
    );
}
#[test]
fn changed_and_orphaned_comments_allow_instruction_saves_without_fuzzy_reanchoring() {
    let (_d, r, _s, p) = setup();
    let t = note(&r, &p, true, 0);
    let block = r.read_manuscript().unwrap().blocks[0].id.clone();
    edit(
        &r,
        &p,
        json!([{"op":"setBlockContent","id":block,"runs":[{"text":"New source","marks":[]}]}]),
    );
    let mut thread = SelfThread::get(&r, &t);
    let quote = thread.anchor.ranges[0].quote.clone();
    assert_eq!(thread.anchor.state, "source_changed");
    thread.text = "Updated comment about original source".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":1}),
    ))
    .unwrap();
    edit(&r, &p, json!([{"op":"deleteBlock","id":block}]));
    let mut thread = SelfThread::get(&r, &t);
    thread.text = "Retained orphan instruction".into();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":2}),
    ))
    .unwrap();
    let current = SelfThread::get(&r, &t);
    assert_eq!(current.anchor.ranges[0].quote, quote);
    assert_eq!(current.anchor.state, "orphaned");
    assert!(!r.has_queued_ai().unwrap());
}
#[test]
fn explicit_delete_decision_keeps_pending_artifact_through_retained_history_pruning() {
    let (_d, r, s, p) = setup();
    let t = note(&r, &p, false, 0);
    let run = start(&r, &s, &p, &t);
    complete(&r, proposal());
    r.reconcile_reviews().unwrap();
    let original = candidate(&r, &t);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DeleteReviewThread",
        json!({"threadId":t,"requestVersion":1,"discardCandidate":true}),
    ))
    .unwrap();
    r.prune_review_payloads().unwrap();
    assert_eq!(
        r.review_candidate(&original.id, 0).unwrap().status,
        "discarded"
    );
    assert!(r.read_result(&run).unwrap().is_some());
    history(&r, &p, false);
    assert_eq!(SelfThread::get(&r, &t).text, "Explain / improve");
    assert!(r.review_candidate(&original.id, 0).is_ok());
}
#[test]
fn deleted_candidate_retention_tracks_history_identity_after_undo_and_branch() {
    let (_d, r, s, p) = setup();
    let mut previous = r.read_manuscript().unwrap().blocks[0].id.clone();
    let mut operations = vec![];
    for _ in 0..4 {
        let b = id();
        operations.push(json!({"op":"insertBlock","after":previous,"block":{"id":b,"kind":"paragraph","attrs":{},"runs":[{"text":"Independent source","marks":[]}]}}));
        previous = b;
    }
    edit(&r, &p, json!(operations));
    let mut threads = vec![];
    for i in 0..5 {
        let t = note(&r, &p, false, i);
        start(&r, &s, &p, &t);
        complete(&r, proposal());
        r.reconcile_reviews().unwrap();
        threads.push(t);
    }
    let deleted = candidate(&r, &threads[0]);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DeleteReviewThread",
        json!({"threadId":threads[0],"requestVersion":1,"discardCandidate":true}),
    ))
    .unwrap();
    for t in &threads[1..] {
        let c = candidate(&r, t);
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "DiscardReviewCandidate",
            json!({"candidate":{"id":c.id,"version":c.version}}),
        ))
        .unwrap();
    }
    for _ in 0..4 {
        history(&r, &p, false);
    }
    let branch = candidate(&r, &threads[1]);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "DiscardReviewCandidate",
        json!({"candidate":{"id":branch.id,"version":branch.version}}),
    ))
    .unwrap();
    assert_eq!(r.read_history().unwrap().undo_count, 2);
    assert_eq!(r.read_history().unwrap().redo_count, 0);
    r.prune_review_payloads().unwrap();
    assert!(r.review_candidate(&deleted.id, 0).is_ok());
    history(&r, &p, false);
    history(&r, &p, false);
    assert!(!SelfThread::get(&r, &threads[0]).deleted);
    assert!(r.review_candidate(&deleted.id, 0).is_ok());
    let c = r.connection.lock().unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM history_entry_identities", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
}
#[test]
fn current_and_historical_review_choices_prevent_shared_visual_preview_expiry() {
    let (_d, r, _s, p) = setup();
    let t = note(&r, &p, true, 0);
    let visual = id();
    let source = id();
    let payload = r.object(b"prepared visual retention fixture").unwrap();
    {
        let c = r.connection.lock().unwrap();
        c.execute("INSERT INTO planning_visuals(id,source_id,source_revision,selection_index,status,object_hash,size,width,height,created_at) VALUES(?1,?2,1,1,'ready',?3,33,1,1,0)",params![visual,source,payload]).unwrap();
    }
    let mut thread = SelfThread::get(&r, &t);
    thread.evidence = vec![PlanningEvidenceChoice {
        source_id: source,
        mode: PlanningEvidenceChoiceMode::Visualinput,
        start: 0,
        end: 0,
        visual_id: visual.clone(),
        allow_unknown_images: true,
    }];
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":1}),
    ))
    .unwrap();
    r.prune_planning_payloads().unwrap();
    assert_eq!(r.planning_visual(&visual).unwrap().status, "ready");
    let mut thread = SelfThread::get(&r, &t);
    thread.evidence.clear();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "SaveReview",
        json!({"thread":thread,"expectedRequestVersion":2}),
    ))
    .unwrap();
    r.prune_planning_payloads().unwrap();
    assert_eq!(r.planning_visual(&visual).unwrap().status, "ready");
}
