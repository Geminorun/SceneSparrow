//! Script transaction adapter. All SQL and object ownership remains in infrastructure.
use crate::{
    SqliteProjectRepository,
    ai::execution::AiUnitOfWork,
    manuscript::{Result, db, hash},
};
use rusqlite::{Connection, OptionalExtension, params};
use scenesparrow_application::ai::*;
use scenesparrow_domain::{
    contracts::*,
    manuscript::{self, BusinessSnapshot, ManuscriptError, Transition},
    planning::{self, ensure},
};
use std::collections::{BTreeMap, BTreeSet};
type PreparedEvidence = (
    Vec<PlanningEvidence>,
    Vec<(AiArtifact, Vec<u8>)>,
    Vec<String>,
);
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn ai<T>(v: scenesparrow_domain::ai::Result<T>) -> Result<T> {
    v.map_err(|e| ManuscriptError(e.0, None))
}
fn to_ai(e: ManuscriptError) -> scenesparrow_domain::ai::AiError {
    scenesparrow_domain::ai::AiError(e.0)
}
fn word<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}
pub struct PlanningCoordinator;
impl ConsumerCoordinator for PlanningCoordinator {
    fn name(&self) -> &str {
        "script-planning"
    }
    fn cancel(
        &self,
        uow: &mut dyn ProjectUnitOfWork,
        run: &AiRun,
    ) -> scenesparrow_domain::ai::Result<bool> {
        uow.fence_consumer(self.name(), &run.binding_id)
    }
}
impl SqliteProjectRepository {
    pub(crate) fn initialize_planning(&self) -> Result<()> {
        let c = db(self.connection.lock())?;
        db(c.execute(
            "INSERT OR IGNORE INTO planning_state(singleton,revision,content_json) VALUES(1,0,?1)",
            [db(serde_json::to_string(&planning::empty()))?],
        ))?;
        db(c.execute("UPDATE planning_visuals SET status='interrupted',error='DOCUMENT_JOB_INTERRUPTED' WHERE status IN ('queued','running')",[]))?;
        db(c.execute("DELETE FROM external_object_pins WHERE owner_id IN (SELECT 'visual:'||id FROM planning_visuals WHERE status='interrupted')",[]))?;
        let p = Self::planning_content(&c)?;
        planning::validate(&p, false)
    }
    pub(crate) fn planning_content(c: &Connection) -> Result<PlanningContent> {
        let json: String = db(c.query_row(
            "SELECT content_json FROM planning_state WHERE singleton=1",
            [],
            |r| r.get(0),
        ))?;
        db(serde_json::from_str(&json))
    }
    fn planning_revision(c: &Connection) -> Result<i64> {
        db(c.query_row(
            "SELECT revision FROM planning_state WHERE singleton=1",
            [],
            |r| r.get(0),
        ))
    }
    fn epoch(c: &Connection) -> Result<i64> {
        db(c.query_row("SELECT epoch FROM planning_history_epoch", [], |r| r.get(0)))
    }
    fn draft_reserved(c: &Connection) -> Result<bool> {
        db(c.query_row("SELECT EXISTS(SELECT 1 FROM script_ai_tasks t JOIN ai_runs r ON r.run_id=t.run_id JOIN application_execution_bindings b ON b.run_id=r.run_id WHERE t.operation='generate_initial_draft' AND t.application='pending' AND b.applicability='pending' AND r.status IN ('queued','running','succeeded'))",[],|r|r.get(0)))
    }
    fn task_at(&self, c: &Connection, id: &str) -> Result<PlanningTask> {
        let (run_id, operation, application, error): (String, String, String, Option<String>) =
            db(c.query_row(
                "SELECT run_id,operation,application,error FROM script_ai_tasks WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional())?
            .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
        let run = ai(Self::ai_run(c, &run_id))?;
        let retained: bool = db(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_artifacts WHERE run_id=?1)",
            [&run_id],
            |r| r.get(0),
        ))?;
        let preview = if retained {
            run.result
                .as_ref()
                .map(|a| {
                    self.read_object(&a.hash).map(|b| {
                        String::from_utf8_lossy(&b)
                            .chars()
                            .take(8192)
                            .collect::<String>()
                    })
                })
                .transpose()?
        } else {
            None
        };
        let metadata: Option<String> = db(c
            .query_row(
                "SELECT metadata_json FROM draft_generation_manifests WHERE task_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        Ok(PlanningTask {
            metadata: metadata
                .map(|json| db(serde_json::from_str(&json)))
                .transpose()?,
            id: id.into(),
            operation,
            application,
            error: error.or(run.error.clone()),
            run,
            preview,
        })
    }
    pub fn read_planning(&self) -> Result<PlanningState> {
        let c = db(self.connection.lock())?;
        let mut tasks = vec![];
        let mut stmt =
            db(c.prepare("SELECT id FROM script_ai_tasks ORDER BY rowid DESC LIMIT 20"))?;
        for row in db(stmt.query_map([], |r| r.get::<_, String>(0)))? {
            tasks.push(self.task_at(&c, &db(row)?)?);
        }
        Ok(PlanningState {
            revision: Self::planning_revision(&c)?,
            content: Self::planning_content(&c)?,
            reserved: Self::draft_reserved(&c)?,
            tasks,
        })
    }
    pub fn planning_task(&self, id: &str) -> Result<PlanningTask> {
        ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        let c = db(self.connection.lock())?;
        self.task_at(&c, id)
    }
    fn assign_nodes(
        c: &Connection,
        old: &PlanningContent,
        new: &mut PlanningContent,
        restore: bool,
    ) -> Result<()> {
        for (position, node) in new.nodes.iter_mut().enumerate() {
            let previous = old.nodes.iter().find(|n| n.id == node.id);
            let high: Option<i64> = db(c
                .query_row(
                    "SELECT high_water FROM planning_node_identities WHERE id=?1",
                    [&node.id],
                    |r| r.get(0),
                )
                .optional())?;
            if let Some(prior) = previous {
                ensure(
                    restore || node.revision == prior.revision,
                    "REVISION_CONFLICT",
                )?;
                let mut compare = node.clone();
                compare.revision = prior.revision;
                let moved = old.nodes.iter().position(|n| n.id == node.id) != Some(position);
                node.revision = if compare == *prior && !moved {
                    prior.revision
                } else {
                    manuscript::next_revision(high.unwrap_or(prior.revision))?
                };
            } else {
                ensure(restore || high.is_none(), "OUTLINE_INVALID")?;
                node.revision = manuscript::next_revision(high.unwrap_or(0))?;
            }
        }
        // Reorders change outline dependencies even when per-node wording is stable.
        Ok(())
    }
    pub(crate) fn planning_transition(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        identities: &BTreeMap<String, i64>,
    ) -> Result<Transition> {
        let old = Self::planning_content(c)?;
        match command {
            ManuscriptCommand::SavePlanning { payload, .. } => {
                planning::validate(&payload.content, false)?;
                ensure(
                    manuscript::uuid4(&payload.group.group_id)
                        && manuscript::uuid4(&payload.group.client_session_id)
                        && payload.group.group_sequence > 0,
                    "INVALID_REQUEST",
                )?;
                let mut content = payload.content.clone();
                Self::assign_nodes(c, &old, &mut content, false)?;
                let changed =
                    planning::content_snapshot(&content) != planning::content_snapshot(&old);
                let mut state = before.clone();
                if changed {
                    state.working_revision = manuscript::next_revision(before.working_revision)?;
                }
                Ok(Transition {
                    locks: None,
                    reviews: None,
                    state,
                    affected: BTreeSet::new(),
                    sources: None,
                    planning: changed.then_some(content),
                    planning_metadata: None,
                    normalized: false,
                })
            }
            ManuscriptCommand::CancelPlanningTask { payload, .. } => {
                ensure(
                    db(c.query_row(
                        "SELECT EXISTS(SELECT 1 FROM script_ai_tasks WHERE id=?1)",
                        [&payload.task_id],
                        |r| r.get::<_, bool>(0),
                    ))?,
                    "OBJECT_NOT_FOUND",
                )?;
                ensure(
                    !db(c.query_row(
                        "SELECT application='applied' FROM script_ai_tasks WHERE id=?1",
                        [&payload.task_id],
                        |r| r.get::<_, bool>(0),
                    ))?,
                    "ALREADY_APPLIED",
                )?;
                Ok(Transition {
                    locks: None,
                    reviews: None,
                    state: before.clone(),
                    affected: BTreeSet::new(),
                    sources: None,
                    planning: None,
                    planning_metadata: None,
                    normalized: false,
                })
            }
            ManuscriptCommand::UsePlanningResult { payload, .. } => {
                let (run_id,operation,dep,_epoch,content_hash,manifest,application):(String,String,String,i64,String,String,String)=db(c.query_row("SELECT run_id,operation,dependencies_hash,history_revision,content_hash,manifest_json,application FROM script_ai_tasks WHERE id=?1",[&payload.task_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional())?.ok_or(ManuscriptError("OBJECT_NOT_FOUND",None))?;
                ensure(
                    application == "pending" || application == "not_applied",
                    "ALREADY_APPLIED",
                )?;
                let (prompt, interpreter): (String, String) = db(c.query_row(
                    "SELECT prompt_version,interpreter_version FROM script_ai_tasks WHERE id=?1",
                    [&payload.task_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?;
                ensure(
                    prompt == scenesparrow_application::planning::PROMPT_VERSION
                        && interpreter == scenesparrow_application::planning::PROMPT_VERSION,
                    "INVALID_OUTPUT",
                )?;
                let run = ai(Self::ai_run(c, &run_id))?;
                ensure(run.status == AiRunStatus::Succeeded, "RESULT_UNAVAILABLE")?;
                ensure(db(c.query_row("SELECT applicability='pending' FROM application_execution_bindings WHERE run_id=?1",[&run_id],|r|r.get::<_,bool>(0)))?,"CONSUMER_CANCELLED")?;
                if operation == "generate_initial_draft" {
                    ensure(
                        before.workspace_stage == ManuscriptStateWorkspaceStage::Outline
                            && before.blocks.is_empty(),
                        "DRAFT_ALREADY_EXISTS",
                    )?;
                }
                ensure(
                    dep == self.dependencies(c, &operation)?,
                    "PLANNING_RESULT_STALE",
                )?;
                let history = Self::history_metadata(c)?;
                ensure(
                    history.history_revision == payload.expected_history_revision,
                    "HISTORY_CONFLICT",
                )?;
                ensure(
                    payload.explicit || history.redo_count == 0,
                    "HISTORY_DIVERGED",
                )?;
                let snapshot: PlanningContent =
                    db(serde_json::from_slice(&self.read_object(&content_hash)?))?;
                let evidence: Vec<PlanningEvidence> = db(serde_json::from_str(&manifest))?;
                let result = run
                    .result
                    .ok_or(ManuscriptError("RESULT_UNAVAILABLE", None))?;
                let bytes = self.read_object(&result.hash)?;
                if operation == "generate_initial_draft" {
                    let blocks = planning::interpret_draft(&bytes, &snapshot, &evidence)?;
                    let mut transition = manuscript::import_candidate(
                        before,
                        blocks,
                        false,
                        identities,
                        self.policy.as_ref(),
                    )?;
                    let output: planning::DraftOutput = db(serde_json::from_slice(&bytes))?;
                    let mut metadata_evidence = evidence;
                    for entry in &mut metadata_evidence {
                        entry.text.clear();
                    }
                    let mut section_mapping = vec![];
                    let mut at = 0;
                    for node in snapshot.nodes {
                        let start = at;
                        at += 1;
                        while at < transition.state.blocks.len()
                            && transition.state.blocks[at].kind != BlockKind::Heading
                        {
                            at += 1;
                        }
                        section_mapping.push(PlanningSectionMapping {
                            outline_node_id: node.id,
                            block_ids: transition.state.blocks[start..at]
                                .iter()
                                .map(|b| b.id.clone())
                                .collect(),
                        });
                    }
                    transition.planning_metadata = Some(PlanningTaskMetadata {
                        verification_hints: output.verification_hints,
                        planning_notes: output.planning_notes,
                        evidence_references: output
                            .evidence_references
                            .into_iter()
                            .map(|r| PlanningResultReference {
                                evidence_id: r.evidence_id,
                                outline_node_id: r.outline_node_id,
                            })
                            .collect(),
                        section_mapping,
                        evidence: metadata_evidence,
                    });
                    Ok(transition)
                } else {
                    let mut p = planning::interpret_outline(
                        &bytes,
                        &snapshot,
                        operation == "adjust_outline",
                    )?;
                    p.instruction = old.instruction.clone();
                    Self::assign_nodes(c, &old, &mut p, true)?;
                    let mut state = before.clone();
                    state.working_revision = manuscript::next_revision(before.working_revision)?;
                    Ok(Transition {
                        locks: None,
                        reviews: None,
                        state,
                        affected: BTreeSet::new(),
                        sources: None,
                        planning: Some(p),
                        planning_metadata: None,
                        normalized: false,
                    })
                }
            }
            _ => Err(ManuscriptError("INVALID_REQUEST", None)),
        }
    }
    pub(crate) fn restore_planning(
        &self,
        c: &Connection,
        t: &mut Transition,
        target: &BusinessSnapshot,
    ) -> Result<()> {
        let old = Self::planning_content(c)?;
        let mut p = target.planning.clone().unwrap_or_else(planning::empty);
        if planning::content_snapshot(&old) != planning::content_snapshot(&p) {
            Self::assign_nodes(c, &old, &mut p, true)?;
            t.planning = Some(p);
        }
        Ok(())
    }
    pub(crate) fn coordinate_planning(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        _before: &ManuscriptState,
        t: &mut Transition,
    ) -> Result<()> {
        if let ManuscriptCommand::RemoveSource { payload, .. } = command {
            let mut p = Self::planning_content(c)?;
            let n = p.evidence.len();
            p.evidence.retain(|e| e.source_id != payload.source_id);
            if n != p.evidence.len() {
                t.planning = Some(p);
            }
        }
        Ok(())
    }
    pub(crate) fn guard_planning(
        &self,
        c: &Connection,
        command: &ManuscriptCommand,
        before: &ManuscriptState,
        t: &Transition,
    ) -> Result<()> {
        if matches!(command, ManuscriptCommand::CancelPlanningTask { .. }) {
            return Ok(());
        }
        if let ManuscriptCommand::UsePlanningResult {payload,..}=command
            && db(c.query_row("SELECT EXISTS(SELECT 1 FROM script_ai_tasks WHERE id=?1 AND operation='generate_initial_draft' AND application='pending')",[&payload.task_id],|r|r.get::<_,bool>(0)))? {return Ok(());}
        if Self::draft_reserved(c)? {
            let old = Self::planning_content(c)?;
            let mut after = t.planning.clone().unwrap_or_else(|| old.clone());
            let mut old = old;
            old.instruction.clear();
            after.instruction.clear();
            let current_sources = Self::source_members(c)?;
            let selected_removed = t.sources.as_ref().is_some_and(|ss| {
                old.evidence.iter().any(|e| {
                    ss.iter().find(|s| s.id == e.source_id)
                        != current_sources.iter().find(|s| s.id == e.source_id)
                })
            });
            ensure(
                before.workspace_stage == t.state.workspace_stage
                    && planning::content_snapshot(&old) == planning::content_snapshot(&after)
                    && !selected_removed,
                "TASK_USING_CONTENT",
            )?;
        }
        Ok(())
    }
    pub(crate) fn planning_typing_scope(
        &self,
        c: &Connection,
        t: &Transition,
    ) -> Result<Option<String>> {
        let Some(p) = &t.planning else {
            return Ok(None);
        };
        let old = Self::planning_content(c)?;
        let a = db(serde_json::to_value(planning::content_snapshot(&old)))?;
        let b = db(serde_json::to_value(planning::content_snapshot(p)))?;
        let mut scopes = vec![];
        for field in ["topic", "language", "audience", "style", "lengthHint"] {
            if a["brief"][field] != b["brief"][field] {
                scopes.push(format!("brief:{field}"));
            }
        }
        if old.instruction != p.instruction {
            scopes.push("instruction".into());
        }
        if old.evidence != p.evidence {
            return Ok(None);
        };
        if old.nodes.len() != p.nodes.len()
            || old
                .nodes
                .iter()
                .zip(&p.nodes)
                .any(|(x, y)| x.id != y.id || x.depth != y.depth)
        {
            return Ok(None);
        };
        for (x, y) in old.nodes.iter().zip(&p.nodes) {
            if x.title != y.title {
                scopes.push(format!("{}:title", x.id));
            }
            if x.key_points != y.key_points {
                scopes.push(format!("{}:points", x.id));
            }
        }
        Ok(if scopes.len() == 1 {
            scopes.pop()
        } else {
            None
        })
    }
    pub(crate) fn commit_planning(
        &self,
        c: &rusqlite::Transaction,
        command: &ManuscriptCommand,
        _before: &ManuscriptState,
        t: &Transition,
    ) -> Result<()> {
        if let Some(p) = &t.planning {
            let old = Self::planning_content(c)?;
            db(c.execute("UPDATE planning_state SET revision=revision+1,brief_revision=brief_revision+?1,outline_revision=outline_revision+?2,evidence_revision=evidence_revision+?3,instruction_revision=instruction_revision+?4,content_json=?5 WHERE singleton=1",params![i64::from(old.brief!=p.brief),i64::from(planning::content_snapshot(&old).nodes!=planning::content_snapshot(p).nodes),i64::from(old.evidence!=p.evidence),i64::from(old.instruction!=p.instruction),db(serde_json::to_string(p))?]))?;
            for n in &p.nodes {
                db(c.execute("INSERT INTO planning_node_identities VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET high_water=MAX(high_water,excluded.high_water)",params![n.id,n.revision]))?;
            }
            Self::planning_event(c, "planning.changed", Some(manuscript::envelope(command).0))?;
        }
        if matches!(
            command,
            ManuscriptCommand::UndoProject { .. } | ManuscriptCommand::RedoProject { .. }
        ) {
            db(c.execute("UPDATE planning_history_epoch SET epoch=epoch+1", []))?;
        }
        if let ManuscriptCommand::CancelPlanningTask { payload, .. } = command {
            let run_id: String = db(c.query_row(
                "SELECT run_id FROM script_ai_tasks WHERE id=?1",
                [&payload.task_id],
                |r| r.get(0),
            ))?;
            let mut uow = AiUnitOfWork {
                tx: c,
                prepared: None,
            };
            let run = ai(Self::ai_run(c, &run_id))?;
            let fenced = ai(PlanningCoordinator.cancel(&mut uow, &run))?;
            if fenced {
                ai(uow.cancel_in_unit_of_work(&run_id))?;
                db(c.execute("UPDATE script_ai_tasks SET application='cancelled',error='CANCELLED' WHERE id=?1",[&payload.task_id]))?;
                Self::planning_event(
                    c,
                    "planningTask.changed",
                    Some(manuscript::envelope(command).0),
                )?;
            }
        }
        if let ManuscriptCommand::UsePlanningResult { payload, .. } = command {
            let run_id: String = db(c.query_row(
                "SELECT run_id FROM script_ai_tasks WHERE id=?1",
                [&payload.task_id],
                |r| r.get(0),
            ))?;
            let changed=db(c.execute("UPDATE application_execution_bindings SET applicability='applied' WHERE run_id=?1 AND applicability='pending'",[&run_id]))?;
            ensure(changed == 1, "CONSUMER_CANCELLED")?;
            db(c.execute("UPDATE script_ai_tasks SET application='applied',error=NULL WHERE id=?1 AND application IN ('pending','not_applied')",[&payload.task_id]))?;
            if t.planning_metadata.is_some() {
                let run = ai(Self::ai_run(c, &run_id))?;
                let content_hash: String = db(c.query_row(
                    "SELECT content_hash FROM script_ai_tasks WHERE id=?1",
                    [&payload.task_id],
                    |r| r.get(0),
                ))?;
                db(c.execute(
                    "INSERT INTO draft_generation_manifests VALUES(?1,?2,?3,?4,?5)",
                    params![
                        payload.task_id,
                        content_hash,
                        run.result
                            .as_ref()
                            .ok_or(ManuscriptError("RESULT_UNAVAILABLE", None))?
                            .hash,
                        db(serde_json::to_string(
                            &t.state.blocks.iter().map(|b| &b.id).collect::<Vec<_>>()
                        ))?,
                        db(serde_json::to_string(
                            t.planning_metadata
                                .as_ref()
                                .ok_or(ManuscriptError("INVALID_OUTPUT", None))?
                        ))?
                    ],
                ))?;
                Self::planning_event(c, "draft.created", Some(manuscript::envelope(command).0))?;
            }
            Self::planning_event(
                c,
                "planningTask.changed",
                Some(manuscript::envelope(command).0),
            )?;
        }
        Ok(())
    }
    fn planning_event(c: &Connection, event: &str, request: Option<&str>) -> Result<()> {
        db(c.execute(
            "INSERT INTO project_events(request_id,event_type,payload_json) VALUES(?1,?2,'{}')",
            params![request.unwrap_or(""), event],
        ))?;
        Ok(())
    }
}
impl SqliteProjectRepository {
    pub(crate) fn manifest(&self, c: &Connection, p: &PlanningContent) -> Result<PreparedEvidence> {
        let sources = Self::source_members(c)?;
        let mut entries = vec![];
        let mut visuals = vec![];
        let mut warnings = vec![];
        if p.evidence.is_empty() {
            warnings.push("NO_EXTERNAL_EVIDENCE".into());
        }
        for (index, choice) in p.evidence.iter().enumerate() {
            let source = sources
                .iter()
                .find(|s| s.id == choice.source_id)
                .ok_or(ManuscriptError("EVIDENCE_NOT_READY", None))?;
            let mut entry = PlanningEvidence {
                id: format!("evidence-{index}"),
                source_id: source.id.clone(),
                source_revision: source.revision,
                content_hash: source
                    .object_hash
                    .clone()
                    .unwrap_or_else(|| hash(source.url.as_deref().unwrap_or_default().as_bytes())),
                level: word(&choice.mode),
                location: String::new(),
                text: String::new(),
                artifact_id: None,
                extractor: "user-link/1".into(),
                warnings: vec![],
            };
            match choice.mode {
                PlanningEvidenceChoiceMode::Linkonly => {
                    ensure(source.kind == SourceKind::Link, "EVIDENCE_CHOICE_REQUIRED")?;
                    entry.text = format!(
                        "{}\n{}",
                        source.title,
                        source.url.as_deref().unwrap_or_default()
                    );
                    entry.warnings.push("LINK_ONLY_NOT_READ".into());
                }
                PlanningEvidenceChoiceMode::Extractedtext
                | PlanningEvidenceChoiceMode::Textonly => {
                    ensure(source.kind == SourceKind::File, "EVIDENCE_CHOICE_REQUIRED")?;
                    let result_hash:Option<String>=db(c.query_row("SELECT result_hash FROM document_attempts WHERE source_id=?1 AND status='ready' ORDER BY rowid DESC LIMIT 1",[&source.id],|r|r.get(0)).optional())?.flatten();
                    let result_hash =
                        result_hash.ok_or(ManuscriptError("EVIDENCE_NOT_READY", None))?;
                    let result: DocumentResult =
                        db(serde_json::from_slice(&self.read_object(&result_hash)?))?;
                    ensure(choice.end > choice.start, "EVIDENCE_CHOICE_REQUIRED")?;
                    let start = choice.start as usize;
                    let end = choice.end as usize;
                    ensure(
                        result.text.is_char_boundary(start)
                            && result.text.is_char_boundary(end)
                            && end <= result.text.len(),
                        "EVIDENCE_CHOICE_REQUIRED",
                    )?;
                    ensure(
                        !result.has_images || choice.mode == PlanningEvidenceChoiceMode::Textonly,
                        "EVIDENCE_CHOICE_REQUIRED",
                    )?;
                    entry.text = result.text[start..end].into();
                    entry.location = format!("utf8:{start}..{end}");
                    entry.extractor = result.parser;
                    entry.content_hash = result_hash;
                    entry.warnings = result.warnings;
                    if start > 0 || end < result.text.len() {
                        entry
                            .warnings
                            .push("EXPLICIT_EXCERPT_OMITS_REMAINDER".into());
                    }
                    if result.has_images {
                        entry.warnings.push("TEXT_ONLY_IMAGES_OMITTED".into());
                    }
                }
                PlanningEvidenceChoiceMode::Visualinput => {
                    let visual = Self::visual(c, &choice.visual_id)?;
                    ensure(
                        visual.source_id == source.id
                            && visual.source_revision == source.revision
                            && visual.status == "ready",
                        "EVIDENCE_NOT_READY",
                    )?;
                    let bytes = self.read_object(
                        visual
                            .hash
                            .as_deref()
                            .ok_or(ManuscriptError("EVIDENCE_NOT_READY", None))?,
                    )?;
                    ensure(
                        bytes.len() <= 4194304 && visual.width <= 4096 && visual.height <= 4096,
                        "INPUT_TOO_LARGE",
                    )?;
                    let a = AiArtifact {
                        id: visual.id.clone(),
                        hash: hash(&bytes),
                        mime: AiArtifactMime::Imagepng,
                        size: bytes.len() as i64,
                    };
                    entry.level = "visual_input".into();
                    entry.location = format!(
                        "selected-image-or-page:{};{}",
                        visual.index, visual.transformation
                    );
                    entry.extractor = "scenesparrow-visual/1".into();
                    entry.artifact_id = Some(a.id.clone());
                    entry.content_hash = a.hash.clone();
                    visuals.push((a, bytes));
                }
            }
            entries.push(entry);
        }
        ensure(
            visuals.len() <= 8 && visuals.iter().map(|(_, v)| v.len()).sum::<usize>() <= 16777216,
            "INPUT_TOO_LARGE",
        )?;
        Ok((entries, visuals, warnings))
    }
    fn dependencies(&self, c: &Connection, operation: &str) -> Result<String> {
        let p = Self::planning_content(c)?;
        let (b,o,e,i):(i64,i64,i64,i64)=db(c.query_row("SELECT brief_revision,outline_revision,evidence_revision,instruction_revision FROM planning_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))))?;
        let mut evidence_tokens = vec![];
        for choice in &p.evidence {
            let source: Option<(i64, String)> = db(c
                .query_row(
                    "SELECT revision,payload_json FROM sources WHERE id=?1",
                    [&choice.source_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional())?;
            let extraction: Option<String> = if matches!(
                choice.mode,
                PlanningEvidenceChoiceMode::Extractedtext | PlanningEvidenceChoiceMode::Textonly
            ) {
                db(c.query_row("SELECT result_hash FROM document_attempts WHERE source_id=?1 AND status='ready' ORDER BY rowid DESC LIMIT 1",[&choice.source_id],|r|r.get(0)).optional())?.flatten()
            } else {
                None
            };
            let visual = if choice.mode == PlanningEvidenceChoiceMode::Visualinput {
                Some(Self::visual(c, &choice.visual_id)?)
            } else {
                None
            };
            evidence_tokens.push((source, extraction, visual));
        }
        Ok(hash(&db(serde_json::to_vec(&(
            b,
            o,
            e,
            if operation == "adjust_outline" { i } else { 0 },
            evidence_tokens,
        )))?))
    }

    pub fn prepare_planning(
        &self,
        settings: &dyn AiSettingsPort,
        request: &PlanningPreparationRequest,
    ) -> Result<PlanningPreparation> {
        let readiness =
            ai(settings.resolve_configuration(AiCategory::Text, AiCapability::Textgenerate))?;
        let config = readiness.configuration;
        let operation = word(&request.operation);
        let (p, revision, epoch, dep, manifest, visuals, mut warnings) = {
            let c = db(self.connection.lock())?;
            if operation == "generate_initial_draft" {
                let state = self.load(&c)?;
                ensure(
                    state.workspace_stage == ManuscriptStateWorkspaceStage::Outline
                        && state.blocks.is_empty(),
                    "STAGE_CONFLICT",
                )?;
            }
            let p = Self::planning_content(&c)?;
            planning::validate(&p, true)?;
            if operation == "generate_outline" {
                ensure(p.nodes.is_empty(), "OUTLINE_INVALID")?;
            } else {
                ensure(!p.nodes.is_empty(), "OUTLINE_REQUIRED")?;
            }
            if operation == "adjust_outline" {
                ensure(!p.instruction.trim().is_empty(), "BRIEF_INVALID")?;
            }
            let (manifest, visuals, warnings) = self.manifest(&c, &p)?;
            (
                p,
                Self::planning_revision(&c)?,
                Self::epoch(&c)?,
                self.dependencies(&c, &operation)?,
                manifest,
                visuals,
                warnings,
            )
        };
        if !visuals.is_empty() {
            ensure(
                config.model.capabilities.images.state != AiEvidenceState::Unsupported,
                "CAPABILITY_UNSUPPORTED",
            )?;
            if config.model.capabilities.images.state == AiEvidenceState::Unknown {
                ensure(
                    p.evidence
                        .iter()
                        .filter(|e| e.mode == PlanningEvidenceChoiceMode::Visualinput)
                        .all(|e| e.allow_unknown_images),
                    "EVIDENCE_CHOICE_REQUIRED",
                )?;
                warnings.push("IMAGE_CAPABILITY_USER_ATTEMPT".into());
            }
        }
        let mut prompt_plan = p.clone();
        if operation != "adjust_outline" {
            prompt_plan.instruction.clear();
        }
        let (mut input, artifacts) = scenesparrow_application::planning::compose(
            &operation,
            &prompt_plan,
            &manifest,
            &visuals,
        )?;
        for a in &mut input.input_artifacts {
            a.hash = hash(
                artifacts
                    .get(&a.id)
                    .ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))?,
            );
        }
        ai(scenesparrow_domain::ai::validate_input(&input, &config))?;
        let input_bytes = db(serde_json::to_vec(&input))?;
        let text_bytes = input
            .messages
            .iter()
            .flat_map(|m| &m.content)
            .map(|part| match part {
                AiPart::Text { text } => text.len(),
                _ => 0,
            })
            .sum::<usize>();
        let schema_bytes = if config.native_json {
            input
                .output_spec
                .schema_artifact_id
                .as_ref()
                .and_then(|id| artifacts.get(id))
                .map_or(0, Vec::len)
        } else {
            0
        };
        let estimated = (text_bytes + schema_bytes).div_ceil(3)
            + visuals.len() * 4096
            + input.messages.len() * 128;
        let output = config.parameters.max_output_tokens;
        if let Some(context) = config.model.context_tokens {
            ensure(estimated as i64 + output <= context, "CONTEXT_LIMIT")?;
        }
        warnings.push("TOKEN_COUNT_ESTIMATE".into());
        let id = uuid::Uuid::new_v4().to_string();
        let expires = now() + 600000;
        // Promote and root everything under the same writer as GC; no preparation
        // becomes usable until all content/artifacts have verified durable bytes.
        let mut c = db(self.connection.lock())?;
        ensure(dep == self.dependencies(&c, &operation)?, "PREFLIGHT_STALE")?;
        let content_hash = self.object(&db(serde_json::to_vec(&p))?)?;
        let input_hash = self.object(&input_bytes)?;
        for bytes in artifacts.values() {
            self.object(bytes)?;
        }
        let mut provenance = vec![];
        for entry in &manifest {
            if self
                .directory
                .join("objects")
                .join(&entry.content_hash)
                .is_file()
            {
                provenance.push(entry.content_hash.clone());
            }
            let source = Self::source_members(&c)?
                .into_iter()
                .find(|s| s.id == entry.source_id)
                .ok_or(ManuscriptError("EVIDENCE_NOT_READY", None))?;
            if let Some(hash) = source.object_hash {
                provenance.push(hash);
            }
        }
        let mut manifest_summary = manifest.clone();
        for entry in &mut manifest_summary {
            entry.text.clear();
        }
        let tx = db(c.transaction())?;
        db(tx.execute(
            "INSERT INTO planning_preparations VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                id,
                expires,
                revision,
                dep,
                epoch,
                operation,
                db(serde_json::to_string(&manifest_summary))?,
                content_hash,
                input_hash,
                config.fingerprint
            ],
        ))?;
        for h in std::iter::once(content_hash)
            .chain(std::iter::once(input_hash))
            .chain(input.input_artifacts.iter().map(|a| a.hash.clone()))
            .chain(provenance)
        {
            db(tx.execute(
                "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
                params![id, h],
            ))?;
        }
        db(tx.commit())?;
        Ok(PlanningPreparation {
            id,
            expires_at: expires,
            planning_revision: revision,
            fingerprint: config.fingerprint.clone(),
            manifest_hash: hash(&db(serde_json::to_vec(&manifest))?),
            evidence: manifest,
            warnings,
            estimated_input_tokens: estimated as i64,
            output_tokens: output,
            configuration: config,
        })
    }
    pub(crate) fn receipt_for(
        c: &Connection,
        command: &ManuscriptCommand,
    ) -> Result<Option<CommandReceipt>> {
        let id = manuscript::envelope(command).0;
        if let Some((digest, outcome)) = Self::outcome(c, id)? {
            ensure(
                digest == hash(&db(serde_json::to_vec(command))?),
                "REQUEST_ID_CONFLICT",
            )?;
            return Self::decode(&outcome).map(Some);
        }
        Ok(None)
    }
    pub(crate) fn write_receipt(
        c: &Connection,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let h = Self::history_metadata(c)?;
        let request = manuscript::envelope(command).0;
        let receipt = CommandReceipt {
            request_id: request.into(),
            working_revision: h.working_revision,
            block_revisions: vec![],
            source_revisions: None,
            history_revision: h.history_revision,
            cursor: h.cursor,
            undo_count: h.undo_count,
            redo_count: h.redo_count,
            undo_label: h.undo_label,
            redo_label: h.redo_label,
            event_sequence: db(c.query_row(
                "SELECT COALESCE(MAX(sequence),0) FROM project_events",
                [],
                |r| r.get(0),
            ))?,
            normalized: false,
        };
        db(c.execute(
            "INSERT INTO command_receipts VALUES(?1,?2,?3)",
            params![
                request,
                hash(&db(serde_json::to_vec(command))?),
                db(serde_json::to_string(&receipt))?
            ],
        ))?;
        Ok(receipt)
    }
    pub fn replay_planning_command(
        &self,
        command: &ManuscriptCommand,
    ) -> Result<Option<CommandReceipt>> {
        let c = db(self.connection.lock())?;
        Self::receipt_for(&c, command)
    }
    pub fn start_planning(
        &self,
        settings: &dyn AiSettingsPort,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let result = self
            .start_planning_inner(settings, command)
            .map_err(|error| {
                if matches!(error.0, "CONFIGURATION_STALE" | "CONFIGURATION_UNAVAILABLE") {
                    ManuscriptError("PREFLIGHT_STALE", None)
                } else {
                    error
                }
            });
        if let Err(error) = &result {
            if manuscript::uuid4(manuscript::envelope(command).0) {
                ai(self.release_ai_preparation(manuscript::envelope(command).0))?;
            }
            if error.0 != "STORAGE_UNAVAILABLE" && error.0 != "REQUEST_ID_CONFLICT" {
                let mut c = db(self.connection.lock())?;
                if let Some(receipt) = Self::receipt_for(&c, command)? {
                    return Ok(receipt);
                }
                let tx = db(c.transaction())?;
                db(tx.execute(
                    "INSERT INTO command_receipts VALUES(?1,?2,?3)",
                    params![
                        manuscript::envelope(command).0,
                        hash(&db(serde_json::to_vec(command))?),
                        serde_json::json!({"error":error.0}).to_string()
                    ],
                ))?;
                db(tx.commit())?;
            }
        }
        result
    }
    fn start_planning_inner(
        &self,
        settings: &dyn AiSettingsPort,
        command: &ManuscriptCommand,
    ) -> Result<CommandReceipt> {
        let (request, project, expected) = manuscript::envelope(command);
        ensure(
            manuscript::uuid4(request) && manuscript::uuid4(project),
            "INVALID_REQUEST",
        )?;
        {
            let c = db(self.connection.lock())?;
            if let Some(receipt) = Self::receipt_for(&c, command)? {
                return Ok(receipt);
            }
        }
        let ManuscriptCommand::StartPlanningTask { payload, .. } = command else {
            return Err(ManuscriptError("INVALID_REQUEST", None));
        };
        ai(self.register_ai_consumer(std::sync::Arc::new(PlanningCoordinator)))?;
        let (
            expires,
            revision,
            dep,
            epoch,
            operation,
            manifest,
            content_hash,
            input_hash,
            fingerprint,
        ): (
            i64,
            i64,
            String,
            i64,
            String,
            String,
            String,
            String,
            String,
        ) = {
            let c = db(self.connection.lock())?;
            db(c.query_row("SELECT expires_at,planning_revision,dependencies_hash,history_revision,operation,manifest_json,content_hash,input_hash,fingerprint FROM planning_preparations WHERE id=?1",[&payload.preparation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).optional())?.ok_or(ManuscriptError("PREFLIGHT_STALE",None))?
        };
        ensure(expires > now(), "PREFLIGHT_STALE")?;
        // Generic preparations are scoped by the exact command identity. Their
        // transfer into a run is rolled back with the script participant below.
        {
            let c = db(self.connection.lock())?;
            db(c.execute(
                "INSERT OR IGNORE INTO ai_preparations VALUES(?1)",
                [request],
            ))?;
            db(c.execute("INSERT OR IGNORE INTO external_object_pins SELECT ?1,object_hash FROM external_object_pins WHERE owner_id=?2",params![request,payload.preparation_id]))?;
        }
        let start = AiStart {
            request_id: request.into(),
            run_id: request.into(),
            binding_id: request.into(),
            consumer: "script-planning".into(),
            fingerprint,
            input_hash,
            retry_of_run_id: payload.retry_of_task_id.clone(),
        };
        ai(self.accept_ai_module(settings,&start,&mut |c,uow,run|{(||->Result<()> {
            if Self::receipt_for(c,command)?.is_some(){return Ok(());}
            ensure(crate::read_project(c).map_err(|_|ManuscriptError("STORAGE_UNAVAILABLE",None))?.is_some_and(|p|p.id==project),"PROJECT_NOT_FOUND")?;
            let (current_revision,stage):(i64,String)=db(c.query_row("SELECT working_revision,workspace_stage FROM manuscripts WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?))))?;
            ensure(current_revision==expected,"REVISION_CONFLICT")?;
            if operation=="generate_initial_draft"{ensure(stage=="outline","DRAFT_ALREADY_EXISTS")?;}
            ensure(expires>now()&&dep==self.dependencies(c,&operation)?,"PREFLIGHT_STALE")?;
            ensure(!db(c.query_row("SELECT EXISTS(SELECT 1 FROM script_ai_tasks t JOIN ai_runs r ON t.run_id=r.run_id WHERE t.application='pending' AND r.status IN ('queued','running','succeeded'))",[],|r|r.get::<_,bool>(0)))?,"PLANNING_TASK_ACTIVE")?;
            if let Some(old)=&payload.retry_of_task_id{let old_operation:String=db(c.query_row("SELECT operation FROM script_ai_tasks WHERE id=?1",[old],|r|r.get(0)).optional())?.ok_or(ManuscriptError("INVALID_RETRY",None))?;ensure(old_operation==operation,"INVALID_RETRY")?;}
            ai(uow.stage_consumer_record("script-planning",request,&run.run_id,"script-planning/1"))?;
            db(c.execute("INSERT INTO script_ai_tasks(id,run_id,operation,planning_revision,dependencies_hash,history_revision,content_hash,manifest_json,application_command_id,prompt_version,interpreter_version) VALUES(?1,?1,?2,?3,?4,?5,?6,?7,?8,'scenesparrow-planning/1','scenesparrow-planning/1')",params![request,operation,revision,dep,epoch,content_hash,manifest,uuid::Uuid::new_v4().to_string()]))?;
            if operation=="generate_initial_draft"{db(c.execute("INSERT INTO outline_confirmations VALUES(?1,?2,?1)",params![request,content_hash]))?;}
            db(c.execute("INSERT OR IGNORE INTO external_object_pins SELECT ?1,object_hash FROM external_object_pins WHERE owner_id=?2",params![format!("script:{request}"),payload.preparation_id]))?;
            Self::planning_event(c,"planningTask.changed",Some(request))?;
            Self::write_receipt(c,command)?;Ok(())
        })().map_err(to_ai)}))?;
        let c = db(self.connection.lock())?;
        Self::receipt_for(&c, command)?.ok_or(ManuscriptError("STORAGE_UNAVAILABLE", None))
    }
    pub fn reconcile_planning(&self) -> Result<()> {
        ai(self.register_ai_consumer(std::sync::Arc::new(PlanningCoordinator)))?;
        let ids = {
            let c = db(self.connection.lock())?;
            let mut stmt = db(c.prepare(
                "SELECT id,application_command_id FROM script_ai_tasks WHERE application='pending'",
            ))?;
            db(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        let mut changed = false;
        for (id, application_id) in ids {
            let run = ai(self.read_run(&id))?;
            if run.status == AiRunStatus::Succeeded {
                changed = true;
                let mut c = db(self.connection.lock())?;
                let (state, history, project) = (
                    self.load(&c)?,
                    Self::history_metadata(&c)?,
                    crate::read_project(&c)
                        .map_err(|_| ManuscriptError("STORAGE_UNAVAILABLE", None))?
                        .ok_or(ManuscriptError("PROJECT_NOT_FOUND", None))?,
                );
                let command: ManuscriptCommand = db(serde_json::from_value(
                    serde_json::json!({"type":"UsePlanningResult","requestId":application_id,"projectId":project.id,"expectedWorkingRevision":state.working_revision,"payload":{"taskId":id,"expectedHistoryRevision":history.history_revision,"explicit":false}}),
                ))?;
                if let Err(error) = self.execute_manuscript_locked(&mut c, &command) {
                    if error.0 == "STORAGE_UNAVAILABLE" {
                        return Err(error);
                    }
                    let tx = db(c.transaction())?;
                    db(tx.execute("UPDATE script_ai_tasks SET application=?2,error=?3 WHERE id=?1 AND application='pending'",params![id,if error.0=="HISTORY_DIVERGED"{"not_applied"}else if error.0=="PLANNING_RESULT_STALE"{"stale"}else{"invalid"},error.0]))?;
                    if error.0 != "HISTORY_DIVERGED" {
                        db(tx.execute("UPDATE application_execution_bindings SET applicability='cancelled' WHERE run_id=?1 AND applicability='pending'",[&id]))?;
                    }
                    Self::planning_event(&tx, "planningTask.changed", None)?;
                    db(tx.commit())?;
                }
            } else if scenesparrow_domain::ai::terminal(&run.status) {
                changed = true;
                let mut c = db(self.connection.lock())?;
                let tx = db(c.transaction())?;
                db(tx.execute("UPDATE script_ai_tasks SET application=?2,error=?3 WHERE id=?1 AND application='pending'",params![id,word(&run.status),run.error]))?;
                Self::planning_event(&tx, "planningTask.changed", None)?;
                db(tx.commit())?;
            }
        }
        if changed {
            self.prune_planning_payloads()?;
        }
        Ok(())
    }
}
impl SqliteProjectRepository {
    fn visual(c: &Connection, id: &str) -> Result<PlanningVisual> {
        ensure(manuscript::uuid4(id), "INVALID_REQUEST")?;
        db(c.query_row("SELECT source_id,source_revision,selection_index,status,error,object_hash,size,width,height,transformation FROM planning_visuals WHERE id=?1",[id],|r|Ok(PlanningVisual{id:id.into(),source_id:r.get(0)?,source_revision:r.get(1)?,index:r.get(2)?,status:r.get(3)?,error:r.get(4)?,hash:r.get(5)?,size:r.get(6)?,width:r.get(7)?,height:r.get(8)?,transformation:r.get(9)?})).optional())?.ok_or(ManuscriptError("OBJECT_NOT_FOUND",None))
    }
    pub fn planning_visual(&self, id: &str) -> Result<PlanningVisual> {
        let c = db(self.connection.lock())?;
        Self::visual(&c, id)
    }
    pub fn begin_planning_visual(&self, action: &PlanningVisualAction) -> Result<PlanningVisual> {
        ensure(
            manuscript::uuid4(&action.id)
                && manuscript::uuid4(&action.source_id)
                && action.index >= 1,
            "INVALID_REQUEST",
        )?;
        let mut c = db(self.connection.lock())?;
        if let Ok(v) = Self::visual(&c, &action.id) {
            ensure(
                v.source_id == action.source_id && v.index == action.index,
                "REQUEST_ID_CONFLICT",
            )?;
            return Ok(v);
        }
        let source = Self::source_members(&c)?
            .into_iter()
            .find(|s| s.id == action.source_id)
            .ok_or(ManuscriptError("OBJECT_NOT_FOUND", None))?;
        ensure(
            source.kind == SourceKind::File
                && (source.title.to_lowercase().ends_with(".docx")
                    || source.title.to_lowercase().ends_with(".pdf")),
            "SOURCE_UNSUPPORTED",
        )?;
        let active: i64 = db(c.query_row(
            "SELECT COUNT(*) FROM planning_visuals WHERE status IN ('queued','running')",
            [],
            |r| r.get(0),
        ))?;
        ensure(active < 8, "QUEUE_FULL")?;
        let tx = db(c.transaction())?;
        db(tx.execute("INSERT INTO planning_visuals(id,source_id,source_revision,selection_index,status) VALUES(?1,?2,?3,?4,'queued')",params![action.id,source.id,source.revision,action.index]))?;
        db(tx.execute(
            "INSERT INTO external_object_pins VALUES(?1,?2)",
            params![format!("visual:{}", action.id), source.object_hash],
        ))?;
        Self::planning_event(&tx, "planningTask.changed", None)?;
        db(tx.commit())?;
        Self::visual(&c, &action.id)
    }
    pub fn cancel_planning_visual(&self, id: &str) -> Result<PlanningVisual> {
        let mut c = db(self.connection.lock())?;
        let tx = db(c.transaction())?;
        db(tx.execute("UPDATE planning_visuals SET status='cancelled',error='CANCELLED' WHERE id=?1 AND status IN ('queued','running')",[id]))?;
        db(tx.execute("DELETE FROM external_object_pins WHERE owner_id=?1 AND EXISTS(SELECT 1 FROM planning_visuals WHERE id=?2 AND status='cancelled')",params![format!("visual:{id}"),id]))?;
        Self::planning_event(&tx, "planningTask.changed", None)?;
        db(tx.commit())?;
        Self::visual(&c, id)
    }
    pub fn run_planning_visual(&self, id: &str) -> Result<()> {
        let _worker = self.worker_guard();
        use base64::{Engine, engine::general_purpose::STANDARD};
        use std::{
            io::{Read, Write},
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        let (source, index) = {
            let c = db(self.connection.lock())?;
            let visual = Self::visual(&c, id)?;
            if self.is_quiescing() {
                return Ok(());
            }
            if visual.status != "queued" {
                return Ok(());
            }
            let source = Self::source_members(&c)?
                .into_iter()
                .find(|s| s.id == visual.source_id && s.revision == visual.source_revision);
            let Some(source) = source else {
                db(c.execute("UPDATE planning_visuals SET status='failed',error='EVIDENCE_NOT_READY' WHERE id=?1",[id]))?;
                db(c.execute(
                    "DELETE FROM external_object_pins WHERE owner_id=?1",
                    [format!("visual:{id}")],
                ))?;
                Self::planning_event(&c, "planningTask.changed", None)?;
                return Ok(());
            };
            db(c.execute(
                "UPDATE planning_visuals SET status='running' WHERE id=?1",
                [id],
            ))?;
            (source, visual.index)
        };
        let mut diagnostics = crate::diagnostics::WorkerSummary::new(None);
        let work = (|| -> Result<(Vec<u8>, i64, i64, String)> {
            let mut command = Command::new("node");
            command.env_clear();
            for key in [
                "PATH",
                "SystemRoot",
                "WINDIR",
                "TEMP",
                "TMP",
                "TMPDIR",
                "LANG",
            ] {
                if let Some(v) = std::env::var_os(key) {
                    command.env(key, v);
                }
            }
            let child = db(command
                .arg("--max-old-space-size=384")
                .arg(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../workers/document/src/visual-entry.mjs"),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn())?;
            struct Child(std::process::Child);
            impl Drop for Child {
                fn drop(&mut self) {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                }
            }
            let mut child = Child(child);
            let path = self.directory.join("objects").join(
                source
                    .object_hash
                    .as_deref()
                    .ok_or(ManuscriptError("EVIDENCE_NOT_READY", None))?,
            );
            let request =
                serde_json::json!({"version":1,"path":path,"name":source.title,"index":index});
            db(child
                .0
                .stdin
                .take()
                .ok_or(ManuscriptError("WORKER_UNAVAILABLE", None))?
                .write_all(request.to_string().as_bytes()))?;
            let stdout = child
                .0
                .stdout
                .take()
                .ok_or(ManuscriptError("WORKER_UNAVAILABLE", None))?;
            let reader = std::thread::spawn(move || {
                let mut bytes = vec![];
                stdout
                    .take(6 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map(|_| bytes)
            });
            let started = Instant::now();
            let mut failure = None;
            loop {
                if self.planning_visual(id)?.status != "running" {
                    failure = Some("CANCELLED");
                }
                if started.elapsed() > Duration::from_secs(60) {
                    failure = Some("DOCUMENT_PARSE_TIMEOUT");
                }
                #[cfg(target_os = "linux")]
                if std::fs::read_to_string(format!("/proc/{}/status", child.0.id()))
                    .ok()
                    .and_then(|s| {
                        s.lines()
                            .find(|s| s.starts_with("VmRSS:"))
                            .and_then(|s| s.split_whitespace().nth(1))
                            .and_then(|s| s.parse::<u64>().ok())
                    })
                    .is_some_and(|kb| kb > 512 * 1024)
                {
                    failure = Some("DOCUMENT_RESOURCE_LIMIT");
                }
                if failure.is_some() {
                    let _ = child.0.kill();
                    let _ = child.0.wait();
                    break;
                }
                if db(child.0.try_wait())?.is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let bytes = db(db(reader.join())?)?;
            if let Some(code) = failure {
                return Err(ManuscriptError(code, None));
            }
            ensure(bytes.len() <= 6 * 1024 * 1024, "DOCUMENT_RESOURCE_LIMIT")?;
            let value: serde_json::Value = db(serde_json::from_slice(&bytes))?;
            if let Some(error) = value["error"].as_str() {
                return Err(ManuscriptError(
                    match error {
                        "OBJECT_NOT_FOUND" => "OBJECT_NOT_FOUND",
                        "SOURCE_UNSUPPORTED" => "SOURCE_UNSUPPORTED",
                        "DOCUMENT_RESOURCE_LIMIT" => "DOCUMENT_RESOURCE_LIMIT",
                        _ => "DOCUMENT_PARSE_FAILED",
                    },
                    None,
                ));
            }
            let result = &value["result"];
            let width = result["width"].as_i64().unwrap_or(0);
            let height = result["height"].as_i64().unwrap_or(0);
            let png = db(STANDARD.decode(result["data"].as_str().unwrap_or_default()))?;
            ensure(
                png.len() <= 4194304
                    && png.starts_with(b"\x89PNG\r\n\x1a\n")
                    && (1..=4096).contains(&width)
                    && (1..=4096).contains(&height),
                "DOCUMENT_RESOURCE_LIMIT",
            )?;
            Ok((
                png,
                width,
                height,
                result["transformation"].as_str().unwrap_or_default().into(),
            ))
        })();
        diagnostics.finish(work.is_ok());
        let mut c = db(self.connection.lock())?;
        if Self::visual(&c, id)?.status != "running" {
            return Ok(());
        }
        let current = Self::source_members(&c)?
            .iter()
            .any(|s| s.id == source.id && s.revision == source.revision);
        let result = if current {
            work
        } else {
            Err(ManuscriptError("EVIDENCE_NOT_READY", None))
        };
        let prepared = match &result {
            Ok((bytes, w, h, t)) => {
                Some((self.object(bytes)?, bytes.len() as i64, *w, *h, t.clone()))
            }
            Err(_) => None,
        };
        let tx = db(c.transaction())?;
        if let Some((hash, size, w, h, t)) = prepared {
            db(tx.execute("UPDATE planning_visuals SET status='ready',object_hash=?2,size=?3,width=?4,height=?5,transformation=?6 WHERE id=?1",params![id,hash,size,w,h,t]))?;
            db(tx.execute(
                "INSERT OR IGNORE INTO external_object_pins VALUES(?1,?2)",
                params![format!("visual:{id}"), hash],
            ))?;
        } else {
            db(tx.execute(
                "UPDATE planning_visuals SET status='failed',error=?2 WHERE id=?1",
                params![id, result.unwrap_err().0],
            ))?;
            db(tx.execute(
                "DELETE FROM external_object_pins WHERE owner_id=?1",
                [format!("visual:{id}")],
            ))?;
        }
        Self::planning_event(&tx, "planningTask.changed", None)?;
        db(tx.commit())?;
        Ok(())
    }
    pub fn has_queued_ai(&self) -> Result<bool> {
        if self.is_quiescing() {
            return Ok(false);
        }
        let c = db(self.connection.lock())?;
        db(c.query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_runs WHERE status='queued')",
            [],
            |r| r.get(0),
        ))
    }
}
impl SqliteProjectRepository {
    pub fn prune_planning_payloads(&self) -> Result<()> {
        let mut c = db(self.connection.lock())?;
        let mut live_blocks = BTreeSet::new();
        let mut visual_roots = Self::planning_content(&c)?
            .evidence
            .into_iter()
            .filter(|e| e.mode == PlanningEvidenceChoiceMode::Visualinput)
            .map(|e| e.visual_id)
            .collect::<BTreeSet<_>>();
        for thread in Self::review_threads(&c)? {
            for e in thread.evidence {
                if e.mode == PlanningEvidenceChoiceMode::Visualinput {
                    visual_roots.insert(e.visual_id);
                }
            }
        }
        for block in self.load(&c)?.blocks {
            live_blocks.insert(block.id);
        }
        let histories = {
            let mut stmt=db(c.prepare("SELECT before_hash FROM history_entries UNION SELECT after_hash FROM history_entries"))?;
            db(stmt.query_map([], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        for hash in histories {
            let root = self.read_business(&hash)?;
            for thread in &root.reviews {
                for e in &thread.evidence {
                    if e.mode == PlanningEvidenceChoiceMode::Visualinput {
                        visual_roots.insert(e.visual_id.clone());
                    }
                }
            }
            if let Some(p) = root.planning {
                for e in p.evidence {
                    if e.mode == PlanningEvidenceChoiceMode::Visualinput {
                        visual_roots.insert(e.visual_id);
                    }
                }
            }
            for block in root.blocks {
                live_blocks.insert(block.id);
            }
        }
        let manifests = {
            let mut stmt =
                db(c.prepare("SELECT task_id,blocks_json FROM draft_generation_manifests"))?;
            db(stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        let mut keep = BTreeSet::new();
        let mut dead_manifests = vec![];
        for (task, blocks) in manifests {
            let blocks: Vec<String> = db(serde_json::from_str(&blocks))?;
            if blocks.iter().any(|b| live_blocks.contains(b)) {
                keep.insert(task);
            } else {
                dead_manifests.push(task);
            }
        }
        let tasks = {
            let mut stmt=db(c.prepare("SELECT t.id,t.operation,t.application,r.status FROM script_ai_tasks t JOIN ai_runs r ON r.run_id=t.run_id ORDER BY t.rowid DESC"))?;
            db(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            }))?
            .map(db)
            .collect::<Result<Vec<_>>>()?
        };
        let mut recovery = BTreeSet::new();
        let mut retire = vec![];
        for (id, op, application, status) in tasks {
            if application == "pending"
                || !matches!(
                    status.as_str(),
                    "succeeded" | "failed" | "cancelled" | "interrupted"
                )
            {
                keep.insert(id);
                continue;
            }
            if application != "pruned" && recovery.insert(op) {
                keep.insert(id.clone());
            }
            if !keep.contains(&id) {
                retire.push(id);
            }
        }
        let expired = {
            let mut stmt =
                db(c.prepare("SELECT id FROM planning_preparations WHERE expires_at<=?1"))?;
            db(stmt.query_map([now()], |r| r.get::<_, String>(0)))?
                .map(db)
                .collect::<Result<Vec<_>>>()?
        };
        let manifests_to_keep = {
            let mut stmt=db(c.prepare("SELECT id,manifest_json FROM script_ai_tasks UNION ALL SELECT id,manifest_json FROM planning_preparations WHERE expires_at>?1"))?;
            db(stmt.query_map([now()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            }))?
            .map(db)
            .collect::<Result<Vec<_>>>()?
        };
        for (id, manifest) in manifests_to_keep {
            if keep.contains(&id) || !retire.contains(&id) {
                let entries: Vec<PlanningEvidence> = db(serde_json::from_str(&manifest))?;
                for e in entries {
                    if let Some(id) = e.artifact_id {
                        visual_roots.insert(id);
                    }
                }
            }
        }
        let visual_rows = {
            let mut stmt = db(
                c.prepare("SELECT id,status,created_at FROM planning_visuals ORDER BY rowid DESC")
            )?;
            db(stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            }))?
            .map(db)
            .collect::<Result<Vec<_>>>()?
        };
        let mut previews = 0;
        let mut retire_visuals = vec![];
        for (id, status, created) in visual_rows {
            if matches!(status.as_str(), "queued" | "running") {
                continue;
            }
            if status == "ready" && created > now() - 600000 && previews < 8 {
                previews += 1;
                visual_roots.insert(id.clone());
            }
            if !visual_roots.contains(&id) {
                retire_visuals.push(id);
            }
        }
        let tx = db(c.transaction())?;
        for id in retire_visuals {
            db(tx.execute(
                "DELETE FROM external_object_pins WHERE owner_id=?1",
                [format!("visual:{id}")],
            ))?;
            db(tx.execute("UPDATE planning_visuals SET status=CASE WHEN status='ready' THEN 'expired' ELSE status END,object_hash=NULL,size=0 WHERE id=?1",[id]))?;
        }
        for id in dead_manifests {
            db(tx.execute(
                "DELETE FROM draft_generation_manifests WHERE task_id=?1",
                [id],
            ))?;
        }
        for id in expired {
            db(tx.execute("DELETE FROM external_object_pins WHERE owner_id=?1", [&id]))?;
            db(tx.execute("DELETE FROM planning_preparations WHERE id=?1", [id]))?;
        }
        for id in retire {
            db(tx.execute("UPDATE application_execution_bindings SET applicability='cancelled' WHERE run_id=?1 AND applicability='pending'",[&id]))?;
            db(tx.execute("UPDATE script_ai_tasks SET application=CASE WHEN application='applied' THEN application ELSE 'pruned' END,manifest_json='[]' WHERE id=?1",[&id]))?;
            db(tx.execute(
                "DELETE FROM external_object_pins WHERE owner_id IN (?1,?2)",
                params![id, format!("script:{id}")],
            ))?;
            db(tx.execute("DELETE FROM ai_artifacts WHERE run_id=?1", [&id]))?;
            db(tx.execute("UPDATE ai_input_snapshots SET payload_retained=0 WHERE input_hash=(SELECT input_hash FROM ai_runs WHERE run_id=?1) AND NOT EXISTS(SELECT 1 FROM ai_runs r WHERE r.input_hash=ai_input_snapshots.input_hash AND r.status IN ('queued','running','cancelling'))",[&id]))?;
        }
        db(tx.commit())?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "planning_tests.rs"]
mod tests;
