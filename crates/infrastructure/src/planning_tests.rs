use super::*;
use crate::ai::settings::SettingsStore;
use scenesparrow_application::{
    ProjectRepository,
    manuscript::{DocumentRepository, ManuscriptRepository},
};
use serde_json::{Value, json};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn setup() -> (
    tempfile::TempDir,
    SqliteProjectRepository,
    SettingsStore,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    let project = r.create("fixture", "Planning 测试").unwrap();
    let settings = SettingsStore::open(&dir.path().join("app")).unwrap();
    crate::ai::tests::configured(&settings, "none");
    (dir, r, settings, project.id)
}
fn cmd(r: &SqliteProjectRepository, p: &str, name: &str, payload: Value) -> ManuscriptCommand {
    serde_json::from_value(json!({"type":name,"requestId":id(),"projectId":p,"expectedWorkingRevision":r.read_manuscript().unwrap().working_revision,"payload":payload})).unwrap()
}
fn save(r: &SqliteProjectRepository, p: &str, content: &PlanningContent) -> CommandReceipt {
    r.execute_manuscript(&cmd(r,p,"SavePlanning",json!({"content":content,"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap()
}
fn plan(r: &SqliteProjectRepository, p: &str, nodes: bool) {
    let mut c = planning::empty();
    c.brief.topic = "解释 中文 🐦".into();
    c.brief.language = "zh-CN".into();
    if nodes {
        c.nodes.push(OutlineNode {
            id: id(),
            revision: 0,
            depth: 0,
            title: "开场".into(),
            key_points: vec!["一句话".into()],
        });
    }
    save(r, p, &c);
}
fn prepare(r: &SqliteProjectRepository, s: &SettingsStore, operation: &str) -> PlanningPreparation {
    r.prepare_planning(
        s,
        &serde_json::from_value(json!({"operation":operation})).unwrap(),
    )
    .unwrap()
}
fn start(
    r: &SqliteProjectRepository,
    s: &SettingsStore,
    p: &str,
    operation: &str,
) -> (String, ManuscriptCommand) {
    let prep = prepare(r, s, operation);
    let command = cmd(
        r,
        p,
        "StartPlanningTask",
        json!({"preparationId":prep.id,"retryOfTaskId":null}),
    );
    let request = manuscript::envelope(&command).0.to_owned();
    r.start_planning(s, &command).unwrap();
    (request, command)
}
fn history(r: &SqliteProjectRepository, p: &str, redo: bool) {
    let h = r.read_history().unwrap();
    let command=serde_json::from_value(json!({"type":if redo{"RedoProject"}else{"UndoProject"},"requestId":id(),"projectId":p,"expectedWorkingRevision":h.working_revision,"expectedHistoryRevision":h.history_revision,"expectedCursor":h.cursor,"payload":{}})).unwrap();
    r.execute_manuscript(&command).unwrap();
}

fn complete(r: &SqliteProjectRepository, value: Value) -> (AiRun, AiCompletion, Vec<u8>) {
    let (run, fence) = r.claim_ai().unwrap().unwrap();
    r.dispatch_ai(&run.run_id, run.attempt, &fence, &run.input_hash)
        .unwrap();
    let bytes = serde_json::to_vec(&value).unwrap();
    let receipt = AiCompletion {
        run_id: run.run_id.clone(),
        attempt: run.attempt,
        fence,
        input_hash: run.input_hash.clone(),
        output_hash: hash(&bytes),
        finish_reason: AiCompletionFinishReason::Stop,
        usage: None,
    };
    r.complete_ai(&receipt, &bytes).unwrap();
    (run, receipt, bytes)
}
fn outline() -> Value {
    json!({"schemaVersion":1,"nodes":[{"existingId":null,"depth":0,"title":"生成标题","keyPoints":["要点"]}]})
}
fn draft(r: &SqliteProjectRepository) -> Value {
    let p = r.read_planning().unwrap().content;
    json!({"schemaVersion":1,"sections":p.nodes.iter().map(|n|json!({"outlineNodeId":n.id,"blocks":[{"kind":"paragraph","attrs":{},"runs":[{"text":"完整初稿 🐦","marks":[{"type":"bold"}]}]}]})).collect::<Vec<_>>(),"evidenceReferences":[],"verificationHints":["Verify claims before publishing"],"planningNotes":["Creative treatment"]})
}
fn cancel(r: &SqliteProjectRepository, p: &str, task: &str) -> Result<CommandReceipt> {
    r.execute_manuscript(&cmd(r, p, "CancelPlanningTask", json!({"taskId":task})))
}
fn first_edit(r: &SqliteProjectRepository, p: &str) -> Result<CommandReceipt> {
    r.execute_manuscript(&cmd(r, p, "ApplyDocumentEdit", json!({"operations":[{"op":"insertBlock","after":null,"block":{"id":id(),"kind":"paragraph","attrs":{},"runs":[{"text":"User manuscript 🐦","marks":[]}]}}],"expectedBlockRevisions":[],"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}})))
}
#[test]
fn partial_outline_saves_but_execution_and_outputs_require_ready_titles() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let mut partial = r.read_planning().unwrap().content;
    partial.nodes[0].title = "  ".into();
    partial.brief.language = "zh-Hans-CN".into();
    save(&r, &p, &partial);
    assert_eq!(r.read_planning().unwrap().content.nodes[0].title, "  ");
    for operation in ["adjust_outline", "generate_initial_draft"] {
        assert_eq!(
            r.prepare_planning(
                &s,
                &serde_json::from_value(json!({"operation":operation})).unwrap()
            )
            .unwrap_err()
            .0,
            "OUTLINE_INVALID"
        );
    }
    partial = r.read_planning().unwrap().content;
    partial.nodes[0].title = "Corrected".into();
    partial.instruction = "Adjust this outline".into();
    save(&r, &p, &partial);
    assert_eq!(
        r.read_planning().unwrap().content.brief.language,
        "zh-Hans-CN"
    );
    prepare(&r, &s, "adjust_outline");
    prepare(&r, &s, "generate_initial_draft");
    let output = json!({"schemaVersion":1,"nodes":[{"existingId":null,"depth":0,"title":" ","keyPoints":[]}]});
    assert_eq!(
        planning::interpret_outline(&serde_json::to_vec(&output).unwrap(), &partial, true)
            .unwrap_err()
            .0,
        "OUTLINE_INVALID"
    );
}

#[test]
fn outline_started_before_manual_typing_finishes_without_replacing_body() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, false);
    let (task, _) = start(&r, &s, &p, "generate_outline");
    first_edit(&r, &p).unwrap();
    let before = r.read_manuscript().unwrap();
    complete(&r, outline());
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "applied");
    let after = r.read_manuscript().unwrap();
    assert_eq!(after.blocks, before.blocks);
    assert_eq!(after.workspace_stage, ManuscriptStateWorkspaceStage::Draft);
    assert_eq!(r.read_planning().unwrap().content.nodes.len(), 1);
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM draft_generation_manifests", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn initial_preparation_cannot_start_after_manual_typing() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let preparation = prepare(&r, &s, "generate_initial_draft");
    first_edit(&r, &p).unwrap();
    let before = r.read_manuscript().unwrap();
    assert_eq!(
        r.start_planning(
            &s,
            &cmd(
                &r,
                &p,
                "StartPlanningTask",
                json!({"preparationId":preparation.id,"retryOfTaskId":null})
            )
        )
        .unwrap_err()
        .0,
        "DRAFT_ALREADY_EXISTS"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(
        r.prepare_planning(
            &s,
            &serde_json::from_value(json!({"operation":"generate_initial_draft"})).unwrap()
        )
        .unwrap_err()
        .0,
        "STAGE_CONFLICT"
    );
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn recoverable_initial_result_cannot_replace_a_subsequent_manual_body() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"Unselected"}),
    ))
    .unwrap();
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    history(&r, &p, false);
    complete(&r, draft(&r));
    r.reconcile_planning().unwrap();
    assert_eq!(
        r.planning_task(&task).unwrap().error.as_deref(),
        Some("HISTORY_DIVERGED")
    );
    assert!(!r.read_planning().unwrap().reserved);
    first_edit(&r, &p).unwrap();
    let before = r.read_manuscript().unwrap();
    let h = r.read_history().unwrap();
    assert_eq!(
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "UsePlanningResult",
            json!({"taskId":task,"expectedHistoryRevision":h.history_revision,"explicit":true})
        ))
        .unwrap_err()
        .0,
        "DRAFT_ALREADY_EXISTS"
    );
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(r.read_history().unwrap(), h);
}
#[test]
fn planning_validation_history_identity_and_reopen() {
    let (dir, r, _, p) = setup();
    plan(&r, &p, true);
    let original = r.read_planning().unwrap().content;
    let mut changed = original.clone();
    changed.nodes[0].key_points = vec!["第一行".into(), "第二行 🐦".into()];
    save(&r, &p, &changed);
    history(&r, &p, false);
    let undo = r.read_planning().unwrap().content;
    assert_eq!(undo.nodes[0].key_points, original.nodes[0].key_points);
    assert!(undo.nodes[0].revision > original.nodes[0].revision);
    history(&r, &p, true);
    let live = r.read_planning().unwrap();
    let mut invalid = live.content.clone();
    invalid.brief.language = "en-abcdefghi".into();
    assert_eq!(r.execute_manuscript(&cmd(&r,&p,"SavePlanning",json!({"content":invalid,"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap_err().0,"BRIEF_INVALID");
    let mut removed = live.content.clone();
    removed.nodes.clear();
    save(&r, &p, &removed);
    assert_eq!(r.execute_manuscript(&cmd(&r,&p,"SavePlanning",json!({"content":live.content,"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap_err().0,"OUTLINE_INVALID");
    drop(r);
    let reopened = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    assert!(reopened.read_planning().unwrap().content.nodes.is_empty());
}
#[test]
fn start_receipts_preflight_and_atomic_participant_rollback() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let prep = prepare(&r, &s, "generate_initial_draft");
    let command = cmd(
        &r,
        &p,
        "StartPlanningTask",
        json!({"preparationId":prep.id,"retryOfTaskId":null}),
    );
    {
        let c = r.connection.lock().unwrap();
        c.execute_batch("CREATE TRIGGER fail_confirmation BEFORE INSERT ON outline_confirmations BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    }
    assert_eq!(
        r.start_planning(&s, &command).unwrap_err().0,
        "STORAGE_UNAVAILABLE"
    );
    assert!(!r.read_planning().unwrap().reserved);
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM ai_runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    r.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_confirmation")
        .unwrap();
    let receipt = r.start_planning(&s, &command).unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.instruction = "unused during draft".into();
    save(&r, &p, &content);
    let view = s.read_settings().unwrap();
    s.update_settings(&AiSettingsUpdate {
        expected_revision: view.settings.revision,
        settings: AiSettings {
            bindings: vec![],
            ..view.settings
        },
    })
    .unwrap();
    assert_eq!(r.start_planning(&s, &command).unwrap(), receipt);
    let mut altered = serde_json::to_value(&command).unwrap();
    altered["payload"]["preparationId"] = json!(id());
    assert_eq!(
        r.start_planning(&s, &serde_json::from_value(altered).unwrap())
            .unwrap_err()
            .0,
        "REQUEST_ID_CONFLICT"
    );
}
#[test]
fn preflight_rejects_saved_plan_and_configuration_changes_without_a_run() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let prep = prepare(&r, &s, "generate_initial_draft");
    let mut content = r.read_planning().unwrap().content;
    content.brief.topic = "Changed".into();
    save(&r, &p, &content);
    let command = cmd(
        &r,
        &p,
        "StartPlanningTask",
        json!({"preparationId":prep.id,"retryOfTaskId":null}),
    );
    assert_eq!(
        r.start_planning(&s, &command).unwrap_err().0,
        "PREFLIGHT_STALE"
    );
    assert_eq!(
        r.start_planning(&s, &command).unwrap_err().0,
        "PREFLIGHT_STALE"
    );
    let prep = prepare(&r, &s, "generate_initial_draft");
    let mut view = s.read_settings().unwrap();
    view.settings.models[0].id = "other".into();
    view.settings.bindings[0].model_id = "other".into();
    s.update_settings(&AiSettingsUpdate {
        expected_revision: view.settings.revision,
        settings: view.settings,
    })
    .unwrap();
    assert_eq!(
        r.start_planning(
            &s,
            &cmd(
                &r,
                &p,
                "StartPlanningTask",
                json!({"preparationId":prep.id,"retryOfTaskId":null})
            )
        )
        .unwrap_err()
        .0,
        "PREFLIGHT_STALE"
    );
    assert!(!r.has_queued_ai().unwrap());
}
#[test]
fn complete_draft_is_atomic_one_history_entry_and_never_reapplied_after_undo_or_restart() {
    let (dir, r, s, p) = setup();
    plan(&r, &p, true);
    let base = r.read_history().unwrap();
    let (task, start) = start(&r, &s, &p, "generate_initial_draft");
    let frozen = r.read_run(&task).unwrap().configuration;
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    let (_, receipt, bytes) = complete(&r, draft(&r));
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    r.reconcile_planning().unwrap();
    let body = r.read_manuscript().unwrap();
    assert_eq!(body.workspace_stage, ManuscriptStateWorkspaceStage::Draft);
    assert_eq!(body.blocks.len(), 2);
    assert_eq!(body.blocks[1].runs[0].marks[0].r#type, MarkType::Bold);
    assert_eq!(r.read_history().unwrap().undo_count, base.undo_count + 1);
    assert_eq!(r.read_run(&task).unwrap().configuration, frozen);
    r.complete_ai(&receipt, &bytes).unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(r.read_manuscript().unwrap(), body);
    assert_eq!(cancel(&r, &p, &task).unwrap_err().0, "ALREADY_APPLIED");
    history(&r, &p, false);
    assert_eq!(
        r.read_manuscript().unwrap().workspace_stage,
        ManuscriptStateWorkspaceStage::Outline
    );
    let original = r.command_receipt(manuscript::envelope(&start).0).unwrap();
    drop(r);
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(
        r.read_manuscript().unwrap().workspace_stage,
        ManuscriptStateWorkspaceStage::Outline
    );
    assert_eq!(r.start_planning(&s, &start).unwrap(), original);
    history(&r, &p, true);
    assert_eq!(
        r.read_manuscript()
            .unwrap()
            .blocks
            .iter()
            .map(|b| &b.id)
            .collect::<Vec<_>>(),
        body.blocks.iter().map(|b| &b.id).collect::<Vec<_>>()
    );
}
#[test]
fn stale_outline_cannot_overwrite_but_unused_instruction_and_unrelated_sources_survive() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, false);
    let (task, _) = start(&r, &s, &p, "generate_outline");
    let mut content = r.read_planning().unwrap().content;
    content.instruction = "Typed after generation began".into();
    save(&r, &p, &content);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"Unrelated"}),
    ))
    .unwrap();
    complete(&r, outline());
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "applied");
    assert_eq!(
        r.read_planning().unwrap().content.instruction,
        content.instruction
    );
    let mut content = r.read_planning().unwrap().content;
    content.instruction = "Shorten".into();
    save(&r, &p, &content);
    let (task, _) = start(&r, &s, &p, "adjust_outline");
    content.brief.topic = "Changed then undo".into();
    save(&r, &p, &content);
    history(&r, &p, false);
    complete(&r, outline());
    r.reconcile_planning().unwrap();
    assert_eq!(
        r.planning_task(&task).unwrap().error.as_deref(),
        Some("PLANNING_RESULT_STALE")
    );
}
#[test]
fn reservation_blocks_all_consumed_mutations_and_cancellation_fences_late_output() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    assert!(r.read_planning().unwrap().reserved);
    assert_eq!(first_edit(&r, &p).unwrap_err().0, "TASK_USING_CONTENT");
    let mut content = r.read_planning().unwrap().content;
    content.nodes[0].title = "Forbidden".into();
    assert_eq!(r.execute_manuscript(&cmd(&r,&p,"SavePlanning",json!({"content":content,"group":{"clientSessionId":id(),"groupId":id(),"groupSequence":1,"kind":"discrete"}}))).unwrap_err().0,"TASK_USING_CONTENT");
    assert_eq!(
        r.execute_manuscript(&cmd(&r, &p, "StartManualDraft", json!({})))
            .unwrap_err()
            .0,
        "TASK_USING_CONTENT"
    );
    let (run, fence) = r.claim_ai().unwrap().unwrap();
    r.dispatch_ai(&run.run_id, run.attempt, &fence, &run.input_hash)
        .unwrap();
    cancel(&r, &p, &task).unwrap();
    assert!(!r.read_planning().unwrap().reserved);
    let bytes = serde_json::to_vec(&draft(&r)).unwrap();
    assert!(
        r.complete_ai(
            &AiCompletion {
                run_id: task.clone(),
                attempt: 1,
                fence,
                input_hash: run.input_hash,
                output_hash: hash(&bytes),
                finish_reason: AiCompletionFinishReason::Stop,
                usage: None
            },
            &bytes
        )
        .is_err()
    );
    r.reconcile_planning().unwrap();
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    r.execute_manuscript(&cmd(&r, &p, "StartManualDraft", json!({})))
        .unwrap();
}
#[test]
fn invalid_complete_outputs_never_save_partial_body_or_outline() {
    for output in [
        json!({"schemaVersion":1,"sections":[],"evidenceReferences":[],"verificationHints":[],"planningNotes":[]}),
        json!({"schemaVersion":1,"sections":[{"outlineNodeId":"foreign","blocks":[]}],"evidenceReferences":[],"verificationHints":[],"planningNotes":[]}),
    ] {
        let (_dir, r, s, p) = setup();
        plan(&r, &p, true);
        let (task, _) = start(&r, &s, &p, "generate_initial_draft");
        let before = r.read_manuscript().unwrap();
        complete(&r, output);
        r.reconcile_planning().unwrap();
        assert_eq!(r.read_manuscript().unwrap(), before);
        assert_eq!(r.planning_task(&task).unwrap().application, "invalid");
        assert!(!r.read_planning().unwrap().reserved);
    }
}
#[test]
fn redo_branch_result_is_recoverable_but_cannot_bypass_a_new_draft_reservation() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let mut content = r.read_planning().unwrap().content;
    content.instruction = "Rewrite".into();
    save(&r, &p, &content);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"unrelated"}),
    ))
    .unwrap();
    let (task, _) = start(&r, &s, &p, "adjust_outline");
    history(&r, &p, false);
    let redo = r.read_history().unwrap().redo_count;
    complete(&r, outline());
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "not_applied");
    assert_eq!(r.read_history().unwrap().redo_count, redo);
    let (new, _) = start(&r, &s, &p, "generate_initial_draft");
    let h = r.read_history().unwrap();
    assert_eq!(
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "UsePlanningResult",
            json!({"taskId":task,"expectedHistoryRevision":h.history_revision,"explicit":true})
        ))
        .unwrap_err()
        .0,
        "TASK_USING_CONTENT"
    );
    cancel(&r, &p, &new).unwrap();
    let h = r.read_history().unwrap();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "UsePlanningResult",
        json!({"taskId":task,"expectedHistoryRevision":h.history_revision,"explicit":true}),
    ))
    .unwrap();
    assert_eq!(r.read_history().unwrap().redo_count, 0);
}
#[test]
fn application_storage_failure_rolls_back_every_business_row_then_saved_result_applies_once() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    complete(&r, draft(&r));
    let before = r.read_manuscript().unwrap();
    let history = r.read_history().unwrap();
    r.connection.lock().unwrap().execute_batch("CREATE TRIGGER reject_application BEFORE UPDATE OF application ON script_ai_tasks WHEN NEW.application='applied' BEGIN SELECT RAISE(FAIL,'fixture');END;").unwrap();
    assert_eq!(r.reconcile_planning().unwrap_err().0, "STORAGE_UNAVAILABLE");
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert_eq!(r.read_history().unwrap(), history);
    assert_eq!(r.planning_task(&task).unwrap().application, "pending");
    r.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_application")
        .unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "applied");
    assert_eq!(r.read_history().unwrap().undo_count, history.undo_count + 1);
}
#[test]
fn same_identity_restore_before_cancellation_is_fenced_and_original_start_receipt_replays() {
    let (dir, r, s, p) = setup();
    plan(&r, &p, true);
    let (task, command) = start(&r, &s, &p, "generate_initial_draft");
    let receipt = r.command_receipt(&task).unwrap();
    let backup = dir.path().join("before-cancel.sqlite");
    r.connection
        .lock()
        .unwrap()
        .backup(rusqlite::DatabaseName::Main, &backup, None)
        .unwrap();
    cancel(&r, &p, &task).unwrap();
    drop(r);
    std::fs::write(
        dir.path().join("project/project.sqlite"),
        std::fs::read(&backup).unwrap(),
    )
    .unwrap();
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(r.read_run(&task).unwrap().status, AiRunStatus::Interrupted);
    assert!(!r.read_planning().unwrap().reserved);
    assert!(!r.has_queued_ai().unwrap());
    assert_eq!(r.start_planning(&s, &command).unwrap(), receipt);
}
#[test]
fn succeeded_result_recovers_locally_after_restart_and_unrelated_undo_redo_does_not_block() {
    let (dir, r, s, p) = setup();
    plan(&r, &p, false);
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":id(),"url":"https://example.com","title":"Unrelated"}),
    ))
    .unwrap();
    let (task, _) = start(&r, &s, &p, "generate_outline");
    history(&r, &p, false);
    history(&r, &p, true);
    complete(&r, outline());
    drop(r);
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "applied");
    assert_eq!(r.read_planning().unwrap().content.nodes.len(), 1);
}
#[test]
fn selected_source_removal_is_one_history_operation_and_draft_reservation_protects_it() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceLink",
        json!({"sourceId":source,"url":"https://example.com","title":"Selected"}),
    ))
    .unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.evidence.push(PlanningEvidenceChoice {
        source_id: source.clone(),
        mode: PlanningEvidenceChoiceMode::Linkonly,
        start: 0,
        end: 0,
        visual_id: String::new(),
        allow_unknown_images: false,
    });
    save(&r, &p, &content);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    let member = r.read_sources(None).unwrap().items.remove(0).source;
    let remove = cmd(
        &r,
        &p,
        "RemoveSource",
        json!({"sourceId":source,"expectedSourceRevision":member.revision}),
    );
    assert_eq!(
        r.execute_manuscript(&remove).unwrap_err().0,
        "TASK_USING_CONTENT"
    );
    cancel(&r, &p, &task).unwrap();
    let before = r.read_history().unwrap();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "RemoveSource",
        json!({"sourceId":source,"expectedSourceRevision":member.revision}),
    ))
    .unwrap();
    assert!(r.read_planning().unwrap().content.evidence.is_empty());
    assert!(r.read_sources(None).unwrap().items.is_empty());
    assert_eq!(r.read_history().unwrap().undo_count, before.undo_count + 1);
    history(&r, &p, false);
    assert_eq!(r.read_planning().unwrap().content.evidence.len(), 1);
    assert_eq!(r.read_sources(None).unwrap().items.len(), 1);
}
#[test]
fn provenance_survives_source_removal_and_history_eviction_then_recovery_payloads_are_bounded() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let intake = id();
    r.begin_intake(&intake, "evidence.txt", "text/plain")
        .unwrap();
    r.append_intake(&intake, b"Evidence original source")
        .unwrap();
    let original = r.complete_intake(&intake).unwrap();
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceFile",
        json!({"sourceId":source,"intakeId":intake,"hash":original.hash}),
    ))
    .unwrap();
    let job = id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: job.clone(),
        source_id: source.clone(),
    })
    .unwrap();
    r.run_document(&job).unwrap();
    let extracted = r
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT result_hash FROM document_attempts WHERE id=?1",
            [&job],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.evidence.push(PlanningEvidenceChoice {
        source_id: source.clone(),
        mode: PlanningEvidenceChoiceMode::Extractedtext,
        start: 0,
        end: 24,
        visual_id: String::new(),
        allow_unknown_images: false,
    });
    save(&r, &p, &content);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    complete(&r, draft(&r));
    r.reconcile_planning().unwrap();
    let result = r.read_run(&task).unwrap().result.unwrap().hash;
    let member = r.read_sources(None).unwrap().items.remove(0).source;
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "RemoveSource",
        json!({"sourceId":source,"expectedSourceRevision":member.revision}),
    ))
    .unwrap();
    for n in 0..7 {
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "AddSourceLink",
            json!({"sourceId":id(),"url":"https://example.com","title":format!("Unrelated {n}")}),
        ))
        .unwrap();
    }
    r.prune_planning_payloads().unwrap();
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    for hash in [original.hash, extracted, result] {
        assert!(!r.read_object(&hash).unwrap().is_empty());
    }
    assert_eq!(r.planning_task(&task).unwrap().application, "applied");
}
#[test]
fn cancel_succeeded_unapplied_wins_and_newer_failures_release_only_their_own_reservations() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    complete(&r, draft(&r));
    cancel(&r, &p, &task).unwrap();
    r.reconcile_planning().unwrap();
    assert_eq!(r.read_run(&task).unwrap().status, AiRunStatus::Succeeded);
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    for _ in 0..3 {
        let (task, _) = start(&r, &s, &p, "generate_initial_draft");
        let (run, fence) = r.claim_ai().unwrap().unwrap();
        r.fail_ai(&run.run_id, &fence, "NETWORK_FAILED").unwrap();
        r.reconcile_planning().unwrap();
        assert!(!r.read_planning().unwrap().reserved);
        assert_eq!(r.planning_task(&task).unwrap().application, "failed");
    }
    r.prune_planning_payloads().unwrap();
    let tasks = r.read_planning().unwrap().tasks;
    assert_eq!(
        tasks.iter().filter(|t| t.application != "pruned").count(),
        1
    );
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert!(r.planning_task(&task).unwrap().preview.is_none());
}
#[test]
fn local_planning_latency_fixture_separates_save_prepare_and_result_application() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let (mut saves, mut preparations, mut applications) = (vec![], vec![], vec![]);
    let mut output_size = 0;
    for n in 0..20 {
        let mut content = r.read_planning().unwrap().content;
        content.brief.audience = format!("Audience {n}");
        let at = std::time::Instant::now();
        save(&r, &p, &content);
        saves.push(at.elapsed().as_micros());
        let at = std::time::Instant::now();
        let prepared = prepare(&r, &s, "generate_initial_draft");
        preparations.push(at.elapsed().as_micros());
        let command = cmd(
            &r,
            &p,
            "StartPlanningTask",
            json!({"preparationId":prepared.id,"retryOfTaskId":null}),
        );
        r.start_planning(&s, &command).unwrap();
        let output = draft(&r);
        output_size = serde_json::to_vec(&output).unwrap().len();
        complete(&r, output);
        let at = std::time::Instant::now();
        r.reconcile_planning().unwrap();
        applications.push(at.elapsed().as_micros());
        history(&r, &p, false);
    }
    saves.sort();
    preparations.sort();
    applications.sort();
    eprintln!(
        "planning_latency_microseconds n=20 plan_bytes={} output_bytes={} save_p50={} save_p95={} prepare_p50={} prepare_p95={} apply_p50={} apply_p95={}",
        serde_json::to_vec(&r.read_planning().unwrap().content)
            .unwrap()
            .len(),
        output_size,
        saves[9],
        saves[18],
        preparations[9],
        preparations[18],
        applications[9],
        applications[18]
    );
}
#[test]
fn rejected_starts_release_their_request_owned_generic_preparation() {
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let prep = prepare(&r, &s, "generate_initial_draft");
    let mut content = r.read_planning().unwrap().content;
    content.brief.topic = "New topic".into();
    save(&r, &p, &content);
    let command = cmd(
        &r,
        &p,
        "StartPlanningTask",
        json!({"preparationId":prep.id,"retryOfTaskId":null}),
    );
    assert_eq!(
        r.start_planning(&s, &command).unwrap_err().0,
        "PREFLIGHT_STALE"
    );
    let request = manuscript::envelope(&command).0;
    let c = r.connection.lock().unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM ai_preparations WHERE owner_id=?1",
            [request],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM external_object_pins WHERE owner_id=?1",
            [request],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(c);
    r.connection
        .lock()
        .unwrap()
        .execute("UPDATE planning_preparations SET expires_at=0", [])
        .unwrap();
    r.prune_planning_payloads().unwrap();
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert_eq!(
        r.start_planning(&s, &command).unwrap_err().0,
        "PREFLIGHT_STALE"
    );
}
#[test]
fn visual_cancelled_and_abandoned_previews_release_payloads_but_keep_identity() {
    use scenesparrow_application::manuscript::DocumentRepository;
    let (_dir, r, _s, p) = setup();
    let intake = id();
    r.begin_intake(&intake, "scanned.pdf", "application/pdf")
        .unwrap();
    r.append_intake(&intake, b"%PDF-not-parsed-for-cancel-test")
        .unwrap();
    let input = r.complete_intake(&intake).unwrap();
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceFile",
        json!({"sourceId":source,"intakeId":intake,"hash":input.hash}),
    ))
    .unwrap();
    let action = PlanningVisualAction {
        id: id(),
        source_id: source.clone(),
        index: 1,
    };
    r.begin_planning_visual(&action).unwrap();
    r.cancel_planning_visual(&action.id).unwrap();
    r.prune_planning_payloads().unwrap();
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM external_object_pins WHERE owner_id=?1",
                [format!("visual:{}", action.id)],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        r.begin_planning_visual(&action).unwrap().status,
        "cancelled"
    );
    let other = PlanningVisualAction { index: 2, ..action };
    assert_eq!(
        r.begin_planning_visual(&other).unwrap_err().0,
        "REQUEST_ID_CONFLICT"
    );
}
#[test]
fn planning_migration_failure_is_atomic_and_s1_draft_can_reopen_without_an_outline() {
    let (dir, r, _s, p) = setup();
    r.execute_manuscript(&cmd(&r, &p, "StartManualDraft", json!({})))
        .unwrap();
    let before = r.read_manuscript().unwrap();
    drop(r);
    let dbpath = dir.path().join("project/project.sqlite");
    let c = Connection::open(&dbpath).unwrap();
    crate::drop_finalization_schema_for_legacy_fixture(&c);
    c.execute_batch("DROP TABLE history_entry_identities;DROP TABLE review_messages;DROP TABLE review_decisions;DROP TABLE review_comparisons;DROP TABLE review_reservations;DROP TABLE review_claims;DROP TABLE review_candidates;DROP TABLE review_tasks;DROP TABLE review_threads;").unwrap();
    c.execute_batch("DROP TABLE planning_visuals;DROP TABLE draft_generation_manifests;DROP TABLE outline_confirmations;DROP TABLE script_ai_tasks;DROP TABLE planning_preparations;DROP TABLE planning_node_identities;DROP TABLE planning_state;DROP TABLE planning_history_epoch;PRAGMA user_version=5;CREATE TABLE planning_state(conflict INTEGER);").unwrap();
    assert!(SqliteProjectRepository::open(&dir.path().join("project")).is_err());
    assert_eq!(
        c.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        5
    );
    let backups = || {
        std::fs::read_dir(dir.path().join("project"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("pre-migration-006-")
            })
            .collect::<BTreeSet<_>>()
    };
    let previous = backups();
    let baseline = previous
        .iter()
        .map(|p| (p.clone(), std::fs::read(p.join("project.sqlite")).unwrap()))
        .collect::<Vec<_>>();
    assert!(previous.len() >= 2);
    c.execute_batch("DROP TABLE planning_state").unwrap();
    drop(c);
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    assert_eq!(r.read_manuscript().unwrap(), before);
    assert!(r.read_planning().unwrap().content.nodes.is_empty());
    assert_eq!(backups().len(), previous.len() + 1);
    for (path, bytes) in baseline {
        assert_eq!(std::fs::read(path.join("project.sqlite")).unwrap(), bytes);
        assert!(path.join("objects").is_dir());
    }
}
#[test]
fn task_cancellation_and_result_application_race_have_one_serialized_outcome() {
    use std::sync::{Arc, Barrier};
    for _ in 0..12 {
        let (_dir, r, s, p) = setup();
        plan(&r, &p, true);
        let (task, _) = start(&r, &s, &p, "generate_initial_draft");
        complete(&r, draft(&r));
        let command = cmd(&r, &p, "CancelPlanningTask", json!({"taskId":task}));
        let r = Arc::new(r);
        let barrier = Arc::new(Barrier::new(3));
        let apply = {
            let r = r.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                r.reconcile_planning()
            })
        };
        let cancel = {
            let r = r.clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                r.execute_manuscript(&command)
            })
        };
        barrier.wait();
        apply.join().unwrap().unwrap();
        let cancellation = cancel.join().unwrap();
        let task = r.planning_task(&task).unwrap();
        if task.application == "applied" {
            assert!(cancellation.is_err());
            assert_eq!(r.read_manuscript().unwrap().blocks.len(), 2);
        } else {
            cancellation.unwrap();
            assert_eq!(task.application, "cancelled");
            assert!(r.read_manuscript().unwrap().blocks.is_empty());
        }
        assert!(!r.read_planning().unwrap().reserved);
    }
}
#[test]
fn idle_and_nonterminal_queue_reconciliation_never_scan_business_snapshots() {
    use std::sync::atomic::Ordering;
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let before = r.business_read_count.load(Ordering::Relaxed);
    for _ in 0..20 {
        r.reconcile_planning().unwrap();
    }
    assert_eq!(r.business_read_count.load(Ordering::Relaxed), before);
    let (_task, _) = start(&r, &s, &p, "generate_initial_draft");
    let before = r.business_read_count.load(Ordering::Relaxed);
    for _ in 0..20 {
        r.reconcile_planning().unwrap();
    }
    assert_eq!(r.business_read_count.load(Ordering::Relaxed), before);
}
#[test]
fn evidence_requires_ready_explicit_unicode_ranges_and_stays_out_of_model_queue() {
    use scenesparrow_application::manuscript::DocumentRepository;
    let (_dir, r, s, p) = setup();
    plan(&r, &p, false);
    let intake = id();
    r.begin_intake(&intake, "source.txt", "text/plain").unwrap();
    r.append_intake(&intake, "中文 source".as_bytes()).unwrap();
    let uploaded = r.complete_intake(&intake).unwrap();
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceFile",
        json!({"sourceId":source,"intakeId":intake,"hash":uploaded.hash}),
    ))
    .unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.evidence.push(PlanningEvidenceChoice {
        source_id: source.clone(),
        mode: PlanningEvidenceChoiceMode::Extractedtext,
        start: 0,
        end: 6,
        visual_id: String::new(),
        allow_unknown_images: false,
    });
    save(&r, &p, &content);
    let request = PlanningPreparationRequest {
        operation: PlanningPreparationRequestOperation::Generateoutline,
    };
    assert_eq!(
        r.prepare_planning(&s, &request).unwrap_err().0,
        "EVIDENCE_NOT_READY"
    );
    assert_eq!(
        r.connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM document_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let job = id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: job.clone(),
        source_id: source,
    })
    .unwrap();
    r.run_document(&job).unwrap();
    content.evidence[0].end = 1;
    save(&r, &p, &content);
    assert_eq!(
        r.prepare_planning(&s, &request).unwrap_err().0,
        "EVIDENCE_CHOICE_REQUIRED"
    );
    content.evidence[0].end = 6;
    save(&r, &p, &content);
    let prep = r.prepare_planning(&s, &request).unwrap();
    assert_eq!(prep.evidence[0].text, "中文");
    assert_eq!(prep.evidence[0].location, "utf8:0..6");
    let stored: String = r
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT manifest_json FROM planning_preparations WHERE id=?1",
            [prep.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!stored.contains("中文"));
    assert!(!r.has_queued_ai().unwrap());
}
#[test]
fn superseded_evidence_context_is_removed_from_sql_and_unpinned_after_expiry() {
    use scenesparrow_application::manuscript::DocumentRepository;
    let (_dir, r, s, p) = setup();
    plan(&r, &p, true);
    let private = "Private evidence marker 🐦 ".repeat(1000);
    let intake = id();
    r.begin_intake(&intake, "context.txt", "text/plain")
        .unwrap();
    r.append_intake(&intake, private.as_bytes()).unwrap();
    let input = r.complete_intake(&intake).unwrap();
    let source = id();
    r.execute_manuscript(&cmd(
        &r,
        &p,
        "AddSourceFile",
        json!({"sourceId":source,"intakeId":intake,"hash":input.hash}),
    ))
    .unwrap();
    let job = id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: job.clone(),
        source_id: source.clone(),
    })
    .unwrap();
    r.run_document(&job).unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.evidence.push(PlanningEvidenceChoice {
        source_id: source,
        mode: PlanningEvidenceChoiceMode::Extractedtext,
        start: 0,
        end: private.len() as i64,
        visual_id: String::new(),
        allow_unknown_images: false,
    });
    save(&r, &p, &content);
    let mut runs = vec![];
    for _ in 0..5 {
        let (task, _) = start(&r, &s, &p, "generate_initial_draft");
        runs.push(r.read_run(&task).unwrap());
        let (run, fence) = r.claim_ai().unwrap().unwrap();
        r.fail_ai(&run.run_id, &fence, "NETWORK_FAILED").unwrap();
        r.reconcile_planning().unwrap();
    }
    let c = r.connection.lock().unwrap();
    let bytes: i64 = c
        .query_row(
            "SELECT SUM(length(manifest_json)) FROM script_ai_tasks",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(bytes < 4096);
    assert_eq!(c.query_row("SELECT COUNT(*) FROM script_ai_tasks WHERE application='pruned' AND manifest_json='[]'",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    c.execute("UPDATE planning_preparations SET expires_at=0", [])
        .unwrap();
    drop(c);
    r.prune_planning_payloads().unwrap();
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert!(r.read_object(&runs[0].input_hash).is_err());
    assert!(r.read_object(&runs[4].input_hash).is_ok());
}

#[test]
fn refresh_clears_reference_consent_but_preserves_running_task_input_and_rejects_stale_draft() {
    let (dir, r, s, p) = setup();
    plan(&r, &p, true);
    let intake = id();
    r.begin_intake(&intake, "source.txt", "text/plain").unwrap();
    r.append_intake(&intake, b"Original evidence").unwrap();
    let original = r.complete_intake(&intake).unwrap();
    let source = id();
    r.execute_manuscript(&cmd(&r, &p, "AddSourceFile", json!({"sourceId":source,"intakeId":intake,"hash":original.hash,"relativePath":"research/source.txt"}))).unwrap();
    let job = id();
    r.document_action(&DocumentAction::ExtractSource {
        job_id: job.clone(),
        source_id: source.clone(),
    })
    .unwrap();
    r.run_document(&job).unwrap();
    let mut content = r.read_planning().unwrap().content;
    content.evidence.push(PlanningEvidenceChoice {
        source_id: source.clone(),
        mode: PlanningEvidenceChoiceMode::Extractedtext,
        start: 0,
        end: 17,
        visual_id: String::new(),
        allow_unknown_images: false,
    });
    save(&r, &p, &content);
    let (task, _) = start(&r, &s, &p, "generate_initial_draft");
    let run = r.read_run(&task).unwrap();
    let pinned_input = r.ai_input_bytes(&run).unwrap();
    let intake = id();
    r.begin_intake(&intake, "source.txt", "text/plain").unwrap();
    r.append_intake(&intake, b"New reference material").unwrap();
    let changed = r.complete_intake(&intake).unwrap();
    let refresh = cmd(
        &r,
        &p,
        "RefreshSourceFile",
        json!({"sourceId":source,"expectedSourceRevision":1,"intakeId":intake,"hash":changed.hash}),
    );
    r.execute_manuscript(&refresh).unwrap();
    assert!(r.read_planning().unwrap().content.evidence.is_empty());
    assert_eq!(r.ai_input_bytes(&run).unwrap(), pinned_input);
    assert_eq!(r.read_run(&task).unwrap().status, AiRunStatus::Queued);
    // Evict the refresh/add history so only the active task can retain the old file.
    for n in 0..7 {
        r.execute_manuscript(&cmd(
            &r,
            &p,
            "AddSourceLink",
            json!({"sourceId":id(),"url":"https://example.com","title":format!("Unrelated {n}")}),
        ))
        .unwrap();
    }
    r.collect_objects(std::time::Duration::ZERO).unwrap();
    assert_eq!(r.read_object(&original.hash).unwrap(), b"Original evidence");
    complete(&r, draft(&r));
    r.reconcile_planning().unwrap();
    assert_eq!(r.planning_task(&task).unwrap().application, "stale");
    assert!(r.read_manuscript().unwrap().blocks.is_empty());
    assert!(!r.has_queued_ai().unwrap());
    drop(r);
    let r = SqliteProjectRepository::open(&dir.path().join("project")).unwrap();
    assert_eq!(r.ai_input_bytes(&run).unwrap(), pinned_input);
    assert!(r.read_planning().unwrap().content.evidence.is_empty());
    // A newly selected range must refer to an extraction of the new content hash.
    let current = r.read_planning().unwrap().content;
    let mut selected = current.clone();
    selected.evidence = content.evidence.clone();
    save(&r, &p, &selected);
    assert_eq!(
        r.prepare_planning(
            &s,
            &serde_json::from_value(json!({"operation":"generate_initial_draft"})).unwrap()
        )
        .unwrap_err()
        .0,
        "EVIDENCE_NOT_READY"
    );
}
