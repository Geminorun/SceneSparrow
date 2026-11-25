//! Session-only external writing. Engines receive text, never a project repository or path.
use scenesparrow_domain::contracts::*;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, &'static str>;
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_EVENTS: usize = 512;
pub const MAX_SESSIONS: usize = 16;
pub const MAX_TURNS: usize = 32;
pub const MAX_SESSION_BYTES: usize = 4 * 1024 * 1024;
pub const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
pub const TURN_TIMEOUT: Duration = Duration::from_secs(120);

pub struct CapturedDocument {
    pub context: AgentContext,
    pub text: String,
}
pub trait AgentDocuments: Send + Sync {
    fn authorize(&self, project: &str) -> Result<()>;
    fn capture(&self, project: &str, attachment: &AgentAttachment) -> Result<CapturedDocument>;
    fn apply(&self, proposal: &AgentProposal) -> Result<MarkdownDocument>;
}

pub struct AgentHistory {
    pub instruction: String,
    pub reply: String,
    pub replacement: Option<String>,
}
pub struct AgentInput {
    pub history: Vec<AgentHistory>,
    pub engine_id: String,
    pub model_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub instruction: String,
    pub context: AgentContext,
    pub text: String,
}
pub enum AgentDelta {
    Text(String),
    Progress(String),
}
pub struct AgentOutput {
    pub reply: String,
    pub replacement: Option<String>,
}
/// Implementations must supervise cleanup and stop on cancellation or an emit error.
/// Only final structured output may contain a replacement; streamed partials are display-only.
/// Batch native token deltas before emitting; MAX_EVENTS is a retained-session storage guard.
pub trait WritingAgent: Send + Sync {
    /// Read cached availability only. Discovery and authentication I/O happen outside this call.
    fn check(&self, engine: &str, model: &str) -> Result<()>;
    fn catalog(&self) -> Result<Vec<AgentEngine>> {
        Ok(vec![AgentEngine {
            id: "codex".into(),
            label: "Codex".into(),
            available: false,
            status: Some(AgentEngineStatus::Notconfigured),
            models: vec![],
        }])
    }
    /// Enqueue native conversation cleanup without blocking; called on close, expiry and shutdown.
    fn close_session(&self, _session_id: &str) {}
    fn run(
        &self,
        input: AgentInput,
        cancelled: Arc<AtomicBool>,
        emit: &mut dyn FnMut(AgentDelta) -> Result<()>,
    ) -> Result<AgentOutput>;
}

struct Turn {
    request: AgentSendTurn,
    view: AgentTurn,
    events: Vec<AgentEvent>,
    output_bytes: usize,
    cancelled: Arc<AtomicBool>,
    started: Instant,
    engine_pending: bool,
    apply: Option<Result<AgentApplyResult>>,
}
struct Session {
    request: AgentCreateSession,
    view: AgentSession,
    turns: Vec<Turn>,
    touched: Instant,
    closed: bool,
}
impl Session {
    fn snapshot(&self) -> AgentSession {
        AgentSession {
            turns: self.turns.iter().map(|t| t.view.clone()).collect(),
            ..self.view.clone()
        }
    }
}
pub struct AgentDispatch {
    pub input: AgentInput,
    pub cancelled: Arc<AtomicBool>,
}
pub struct AgentSessions {
    documents: Arc<dyn AgentDocuments>,
    adapter: Arc<dyn WritingAgent>,
    sessions: Mutex<HashMap<String, Session>>,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}
fn session<'a>(
    sessions: &'a mut HashMap<String, Session>,
    project: &str,
    id: &str,
) -> Result<&'a mut Session> {
    let s = sessions
        .get_mut(id)
        .filter(|s| s.view.project_id == project)
        .ok_or("AGENT_SESSION_NOT_FOUND")?;
    if s.closed || s.touched.elapsed() >= SESSION_TTL {
        return Err("AGENT_SESSION_CLOSED");
    }
    s.touched = Instant::now();
    for t in &mut s.turns {
        if t.view.status == AgentTurnStatus::Running && t.started.elapsed() >= TURN_TIMEOUT {
            settle(
                t,
                &s.view,
                AgentTurnStatus::Failed,
                Some("AGENT_TIMEOUT"),
                String::new(),
            );
        }
    }
    Ok(s)
}
fn event(t: &Turn, s: &AgentSession, delta: AgentDelta) -> AgentEvent {
    let sequence = t.events.len() as i64 + 1;
    match delta {
        AgentDelta::Text(text) => AgentEvent::Text {
            sequence,
            project_id: s.project_id.clone(),
            session_id: s.id.clone(),
            turn_id: t.view.id.clone(),
            text,
        },
        AgentDelta::Progress(text) => AgentEvent::Progress {
            sequence,
            project_id: s.project_id.clone(),
            session_id: s.id.clone(),
            turn_id: t.view.id.clone(),
            text,
        },
    }
}
fn settle(
    t: &mut Turn,
    s: &AgentSession,
    status: AgentTurnStatus,
    code: Option<&str>,
    reply: String,
) {
    if t.view.status != AgentTurnStatus::Running {
        return;
    }
    t.cancelled.store(true, Ordering::Release);
    t.view.status = status.clone();
    t.view.error_code = code.map(str::to_owned);
    t.events.push(AgentEvent::Final {
        sequence: t.events.len() as i64 + 1,
        project_id: s.project_id.clone(),
        session_id: s.id.clone(),
        turn_id: t.view.id.clone(),
        status,
        reply,
        error_code: code.map(str::to_owned),
    });
}
impl AgentSessions {
    pub fn new(documents: Arc<dyn AgentDocuments>, adapter: Arc<dyn WritingAgent>) -> Self {
        Self {
            documents,
            adapter,
            sessions: Mutex::new(HashMap::new()),
        }
    }
    pub fn catalog(&self) -> Result<Vec<AgentEngine>> {
        self.adapter.catalog()
    }
    pub fn create(&self, project: &str, request: AgentCreateSession) -> Result<AgentSession> {
        if !identifier(&request.request_id)
            || !identifier(&request.engine_id)
            || !valid_text(&request.model_id, 128)
            || request.model_id.trim().is_empty()
            || request.model_id.chars().any(char::is_control)
        {
            return Err("AGENT_REQUEST_INVALID");
        }
        // Validate project access even when the engine is unavailable.
        self.documents.authorize(project)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        sessions.retain(|_, s| {
            if !s.closed && s.touched.elapsed() < SESSION_TTL {
                return true;
            }
            for t in &s.turns {
                t.cancelled.store(true, Ordering::Release);
            }
            if !s.closed {
                self.adapter.close_session(&s.view.id);
            }
            false
        });
        if let Some(s) = sessions
            .values()
            .find(|s| s.view.project_id == project && s.request.request_id == request.request_id)
        {
            return if s.request == request {
                Ok(s.snapshot())
            } else {
                Err("AGENT_REQUEST_CONFLICT")
            };
        }
        self.adapter.check(&request.engine_id, &request.model_id)?;
        if sessions.len() >= MAX_SESSIONS {
            return Err("AGENT_SESSION_LIMIT");
        }
        let view = AgentSession {
            id: Uuid::new_v4().to_string(),
            project_id: project.into(),
            engine_id: request.engine_id.clone(),
            model_id: request.model_id.clone(),
            turns: vec![],
        };
        sessions.insert(
            view.id.clone(),
            Session {
                request,
                view: view.clone(),
                turns: vec![],
                touched: Instant::now(),
                closed: false,
            },
        );
        Ok(view)
    }
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for s in sessions.values_mut() {
                for t in &s.turns {
                    t.cancelled.store(true, Ordering::Release);
                }
                if !s.closed {
                    self.adapter.close_session(&s.view.id);
                }
                s.closed = true;
                s.turns.clear();
            }
        }
    }
    pub fn expire(&self) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        sessions.retain(|_, s| {
            if s.touched.elapsed() < SESSION_TTL {
                return true;
            }
            for t in &s.turns {
                t.cancelled.store(true, Ordering::Release);
            }
            if !s.closed {
                self.adapter.close_session(&s.view.id);
            }
            false
        });
        Ok(())
    }
    pub fn read(&self, project: &str, id: &str) -> Result<AgentSession> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        Ok(session(&mut sessions, project, id)?.snapshot())
    }
    pub fn start(
        &self,
        project: &str,
        id: &str,
        request: AgentSendTurn,
    ) -> Result<(AgentTurn, Option<AgentDispatch>)> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        if let Some(t) = s
            .turns
            .iter()
            .find(|t| t.request.request_id == request.request_id)
        {
            return if t.request == request {
                Ok((t.view.clone(), None))
            } else {
                Err("AGENT_REQUEST_CONFLICT")
            };
        }
        if s.turns
            .iter()
            .any(|t| t.view.status == AgentTurnStatus::Running || t.engine_pending)
        {
            return Err("AGENT_TURN_ACTIVE");
        }
        if !identifier(&request.request_id)
            || request.instruction.trim().is_empty()
            || !valid_text(&request.instruction, 16 * 1024)
        {
            return Err("AGENT_REQUEST_INVALID");
        }
        if s.turns.len() >= MAX_TURNS {
            return Err("AGENT_TURN_LIMIT");
        }
        let captured = self.documents.capture(project, &request.attachment)?;
        let bytes = serde_json::to_vec(&request)
            .map_err(|_| "AGENT_REQUEST_INVALID")?
            .len()
            * 4
            + 3 * MAX_OUTPUT_BYTES
            + 128 * 1024;
        let retained = s
            .turns
            .iter()
            .map(|t| {
                // Serialized lengths include duplicated context/proposal strings; double for allocation slack.
                2 * (serde_json::to_vec(&t.request).map_or(MAX_SESSION_BYTES, |v| v.len())
                    + serde_json::to_vec(&t.view).map_or(MAX_SESSION_BYTES, |v| v.len())
                    + serde_json::to_vec(&t.events).map_or(MAX_SESSION_BYTES, |v| v.len()))
                    + 4096
            })
            .sum::<usize>();
        if retained + bytes > MAX_SESSION_BYTES {
            return Err("AGENT_SESSION_LIMIT");
        }
        self.adapter.check(&s.view.engine_id, &s.view.model_id)?;
        let view = AgentTurn {
            id: Uuid::new_v4().to_string(),
            request_id: request.request_id.clone(),
            context: captured.context,
            status: AgentTurnStatus::Running,
            error_code: None,
            proposal: None,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let dispatch = AgentDispatch {
            input: AgentInput {
                history: s
                    .turns
                    .iter()
                    .rev()
                    .filter(|t| t.view.status == AgentTurnStatus::Completed)
                    .take(8)
                    .map(|t| AgentHistory {
                        instruction: t.request.instruction.clone(),
                        reply: t
                            .events
                            .iter()
                            .find_map(|e| match e {
                                AgentEvent::Final { reply, .. } => Some(reply.clone()),
                                _ => None,
                            })
                            .unwrap_or_default(),
                        replacement: t.view.proposal.as_ref().map(|p| p.text.clone()),
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect(),
                engine_id: s.view.engine_id.clone(),
                model_id: s.view.model_id.clone(),
                session_id: id.into(),
                turn_id: view.id.clone(),
                instruction: request.instruction.clone(),
                context: view.context.clone(),
                text: captured.text,
            },
            cancelled: cancelled.clone(),
        };
        s.turns.push(Turn {
            request,
            view: view.clone(),
            events: vec![],
            output_bytes: 0,
            cancelled,
            started: Instant::now(),
            engine_pending: true,
            apply: None,
        });
        Ok((view, Some(dispatch)))
    }
    pub fn run(&self, dispatch: AgentDispatch) {
        let project = dispatch.input.context.project_id.clone();
        let id = dispatch.input.session_id.clone();
        let turn = dispatch.input.turn_id.clone();
        if dispatch.cancelled.load(Ordering::Acquire) {
            let _ = self.release_dispatch(&project, &id, &turn);
            return;
        }
        let result = self
            .adapter
            .run(dispatch.input, dispatch.cancelled, &mut |delta| {
                self.emit(&project, &id, &turn, delta)
            });
        let _ = self.release_dispatch(&project, &id, &turn);
        let _ = self.finish(&project, &id, &turn, result);
    }
    /// A cancelled turn remains reserved until the adapter has actually stopped using its conversation.
    pub fn release_dispatch(&self, project: &str, id: &str, turn: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter_mut()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        t.engine_pending = false;
        Ok(())
    }
    pub fn emit(&self, project: &str, id: &str, turn: &str, delta: AgentDelta) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter_mut()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        if t.view.status != AgentTurnStatus::Running {
            return Err("AGENT_TURN_SETTLED");
        }
        let text = match &delta {
            AgentDelta::Text(v) | AgentDelta::Progress(v) => v,
        };
        if !valid_text(text, MAX_OUTPUT_BYTES)
            || t.output_bytes + text.len() > MAX_OUTPUT_BYTES
            || t.events.len() >= MAX_EVENTS - 2
        {
            settle(
                t,
                &s.view,
                AgentTurnStatus::Failed,
                Some("AGENT_OUTPUT_LIMIT"),
                String::new(),
            );
            return Err("AGENT_OUTPUT_LIMIT");
        }
        t.output_bytes += text.len();
        t.events.push(event(t, &s.view, delta));
        Ok(())
    }
    pub fn finish(
        &self,
        project: &str,
        id: &str,
        turn: &str,
        output: Result<AgentOutput>,
    ) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter_mut()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        if t.view.status != AgentTurnStatus::Running {
            return Ok(());
        }
        // Validate the complete result before publishing any proposal. Failures retain display partials only.
        let output = match output.and_then(|o| {
            if !valid_text(&o.reply, MAX_OUTPUT_BYTES)
                || o.replacement
                    .as_ref()
                    .is_some_and(|v| !valid_text(v, MAX_OUTPUT_BYTES))
                || o.reply.len() + o.replacement.as_ref().map_or(0, String::len) > MAX_OUTPUT_BYTES
            {
                return Err("AGENT_OUTPUT_LIMIT");
            }
            if o.replacement.is_some() && t.view.context.selection.is_none() {
                return Err("AGENT_OUTPUT_INVALID");
            }
            if o.reply.trim().is_empty() && o.replacement.is_none() {
                return Err("AGENT_OUTPUT_INVALID");
            }
            Ok(o)
        }) {
            Ok(o) => o,
            Err(code) => {
                settle(
                    t,
                    &s.view,
                    AgentTurnStatus::Failed,
                    Some(code),
                    String::new(),
                );
                return Ok(());
            }
        };
        if let Some(text) = output.replacement {
            let proposal = AgentProposal {
                id: Uuid::new_v4().to_string(),
                context: t.view.context.clone(),
                text,
            };
            t.events.push(AgentEvent::Proposal {
                sequence: t.events.len() as i64 + 1,
                project_id: project.into(),
                session_id: id.into(),
                turn_id: turn.into(),
                proposal: proposal.clone(),
            });
            t.view.proposal = Some(proposal);
        }
        settle(t, &s.view, AgentTurnStatus::Completed, None, output.reply);
        Ok(())
    }
    pub fn cancel(&self, project: &str, id: &str, turn: &str) -> Result<AgentTurn> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter_mut()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        settle(t, &s.view, AgentTurnStatus::Cancelled, None, String::new());
        Ok(t.view.clone())
    }
    pub fn close(&self, project: &str, id: &str) -> Result<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = sessions
            .get_mut(id)
            .filter(|s| s.view.project_id == project)
            .ok_or("AGENT_SESSION_NOT_FOUND")?;
        for t in &mut s.turns {
            settle(t, &s.view, AgentTurnStatus::Cancelled, None, String::new());
        }
        if !s.closed {
            self.adapter.close_session(id);
        }
        s.closed = true;
        s.turns.clear();
        Ok(())
    }
    pub fn events(
        &self,
        project: &str,
        id: &str,
        turn: &str,
        after: i64,
    ) -> Result<(Vec<AgentEvent>, bool)> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        if after < 0 || after as usize > t.events.len() {
            return Err("AGENT_CURSOR_INVALID");
        }
        Ok((
            t.events[after as usize..].to_vec(),
            t.view.status != AgentTurnStatus::Running,
        ))
    }
    pub fn apply(
        &self,
        project: &str,
        id: &str,
        turn: &str,
        proposal: &str,
    ) -> Result<AgentApplyResult> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "AGENT_STATE_UNAVAILABLE")?;
        let s = session(&mut sessions, project, id)?;
        let t = s
            .turns
            .iter_mut()
            .find(|t| t.view.id == turn)
            .ok_or("AGENT_TURN_NOT_FOUND")?;
        let p = t
            .view
            .proposal
            .as_ref()
            .filter(|p| p.id == proposal && p.context.project_id == project)
            .ok_or("AGENT_PROPOSAL_NOT_FOUND")?;
        if let Some(result) = &t.apply {
            return result.clone();
        }
        let result = self.documents.apply(p).and_then(|doc| {
            Ok(AgentApplyResult {
                project_id: doc.project_id,
                kind: doc.kind,
                revision: doc.revision.ok_or("AGENT_STATE_UNAVAILABLE")?,
                proposal_id: p.id.clone(),
            })
        });
        // A repeated Apply returns the original outcome, including conflicts; retry needs a new turn.
        t.apply = Some(result.clone());
        result
    }
}

impl Drop for AgentSessions {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for s in sessions.values() {
                for t in &s.turns {
                    t.cancelled.store(true, Ordering::Release);
                }
                if !s.closed {
                    self.adapter.close_session(&s.view.id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    struct Documents;
    impl AgentDocuments for Documents {
        fn authorize(&self, _: &str) -> Result<()> {
            Ok(())
        }
        fn capture(&self, project: &str, a: &AgentAttachment) -> Result<CapturedDocument> {
            Ok(CapturedDocument {
                context: AgentContext {
                    project_id: project.into(),
                    kind: a.kind.clone(),
                    revision: a.revision.clone(),
                    source_digest: a.source_digest.clone(),
                    selection: a.selection.clone(),
                },
                text: "Saved source".into(),
            })
        }
        fn apply(&self, _: &AgentProposal) -> Result<MarkdownDocument> {
            unreachable!()
        }
    }
    #[derive(Default)]
    struct Adapter {
        closes: AtomicUsize,
    }
    impl WritingAgent for Adapter {
        fn check(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn close_session(&self, _: &str) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
        fn run(
            &self,
            _: AgentInput,
            _: Arc<AtomicBool>,
            _: &mut dyn FnMut(AgentDelta) -> Result<()>,
        ) -> Result<AgentOutput> {
            unreachable!()
        }
    }
    fn create(s: &AgentSessions, n: usize) -> AgentSession {
        s.create(
            "project",
            AgentCreateSession {
                request_id: format!("session-{n}"),
                engine_id: "fixture".into(),
                model_id: "gpt-5.4".into(),
            },
        )
        .unwrap()
    }
    fn request() -> AgentSendTurn {
        AgentSendTurn {
            request_id: "turn".into(),
            instruction: "Question".into(),
            attachment: AgentAttachment {
                kind: MarkdownDocumentKind::Manuscript,
                revision: Some("saved".into()),
                source_digest: "saved".into(),
                selection: None,
                buffer: None,
            },
        }
    }
    #[test]
    fn ewa_followup_uses_only_completed_history_from_its_own_session() {
        let s = AgentSessions::new(Arc::new(Documents), Arc::new(Adapter::default()));
        let view = create(&s, 0);
        for n in 0..10 {
            let mut request = request();
            request.request_id = format!("history-{n}");
            let (turn, dispatch) = s.start("project", &view.id, request).unwrap();
            let history = dispatch.unwrap().input.history;
            assert_eq!(history.len(), n.min(8));
            if n > 0 {
                assert_eq!(history.last().unwrap().reply, format!("Reply {}", n - 1));
            }
            s.release_dispatch("project", &view.id, &turn.id).unwrap();
            s.finish(
                "project",
                &view.id,
                &turn.id,
                Ok(AgentOutput {
                    reply: format!("Reply {n}"),
                    replacement: None,
                }),
            )
            .unwrap();
        }
        let other = create(&s, 1);
        let (_, dispatch) = s.start("project", &other.id, request()).unwrap();
        assert!(dispatch.unwrap().input.history.is_empty());
        let mut request = request();
        request.request_id = "cancelled".into();
        let (turn, _) = s.start("project", &view.id, request.clone()).unwrap();
        s.cancel("project", &view.id, &turn.id).unwrap();
        s.release_dispatch("project", &view.id, &turn.id).unwrap();
        request.request_id = "after-cancel".into();
        let (_, dispatch) = s.start("project", &view.id, request).unwrap();
        assert_eq!(
            dispatch.unwrap().input.history.last().unwrap().reply,
            "Reply 9"
        );
    }
    #[test]
    fn ewa_timeout_expiry_shutdown_and_capacity_cleanup_are_fenced() {
        let adapter = Arc::new(Adapter::default());
        let s = AgentSessions::new(Arc::new(Documents), adapter.clone());
        let view = create(&s, 0);
        let (turn, dispatch) = s.start("project", &view.id, request()).unwrap();
        let dispatch = dispatch.unwrap();
        s.sessions.lock().unwrap().get_mut(&view.id).unwrap().turns[0].started =
            Instant::now() - TURN_TIMEOUT;
        let timed_out = s.read("project", &view.id).unwrap();
        assert_eq!(
            timed_out.turns[0].error_code.as_deref(),
            Some("AGENT_TIMEOUT")
        );
        assert!(dispatch.cancelled.load(Ordering::Acquire));
        s.finish(
            "project",
            &view.id,
            &turn.id,
            Ok(AgentOutput {
                reply: "Late".into(),
                replacement: Some("Wrong".into()),
            }),
        )
        .unwrap();
        assert!(
            s.read("project", &view.id).unwrap().turns[0]
                .proposal
                .is_none()
        );
        let mut retry = request();
        retry.request_id = "retry".into();
        assert_eq!(
            s.start("project", &view.id, retry.clone())
                .err()
                .map(|e| e.to_owned()),
            Some("AGENT_TURN_ACTIVE".into())
        );
        s.release_dispatch("project", &view.id, &turn.id).unwrap();
        let (_, next) = s.start("project", &view.id, retry).unwrap();
        let next = next.unwrap();
        s.sessions
            .lock()
            .unwrap()
            .get_mut(&view.id)
            .unwrap()
            .touched = Instant::now() - SESSION_TTL;
        s.expire().unwrap();
        assert!(next.cancelled.load(Ordering::Acquire));
        assert_eq!(adapter.closes.load(Ordering::Acquire), 1);
        assert!(s.read("project", &view.id).is_err());
        for n in 1..=MAX_SESSIONS {
            create(&s, n);
        }
        assert_eq!(
            s.create(
                "project",
                AgentCreateSession {
                    request_id: "full".into(),
                    engine_id: "fixture".into(),
                    model_id: "gpt-5.4".into()
                }
            )
            .unwrap_err(),
            "AGENT_SESSION_LIMIT"
        );
        s.shutdown();
        assert_eq!(adapter.closes.load(Ordering::Acquire), MAX_SESSIONS + 1);
        let fresh = create(&s, MAX_SESSIONS + 1);
        assert_eq!(s.read("project", &fresh.id).unwrap().turns.len(), 0);
    }
    #[test]
    fn ewa_retained_output_budget_releases_short_turn_headroom_but_bounds_large_history() {
        let s = AgentSessions::new(Arc::new(Documents), Arc::new(Adapter::default()));
        let view = create(&s, 0);
        let mut accepted = 0;
        for n in 0..MAX_TURNS {
            let mut request = request();
            request.request_id = format!("turn-{n}");
            match s.start("project", &view.id, request) {
                Ok((turn, _)) => {
                    accepted += 1;
                    s.release_dispatch("project", &view.id, &turn.id).unwrap();
                    s.finish(
                        "project",
                        &view.id,
                        &turn.id,
                        Ok(AgentOutput {
                            reply: "x".repeat(MAX_OUTPUT_BYTES),
                            replacement: None,
                        }),
                    )
                    .unwrap();
                }
                Err(code) => {
                    assert_eq!(code, "AGENT_SESSION_LIMIT");
                    break;
                }
            }
        }
        assert!((4..MAX_TURNS).contains(&accepted));
    }
}
