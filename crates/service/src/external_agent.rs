use crate::{api_error, contracts::*};
use axum::{
    Json, Router,
    extract::{FromRef, Path, Query, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response, Sse, sse::Event},
    routing::{get, post},
};
use scenesparrow_application::external_agent::{AgentSessions, Result, TURN_TIMEOUT};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub(crate) struct AgentState {
    pub sessions: Arc<AgentSessions>,
    operations: Arc<Semaphore>,
    runs: Arc<Semaphore>,
    streams: Arc<Semaphore>,
}
impl AgentState {
    pub fn new(sessions: AgentSessions) -> Self {
        Self {
            sessions: Arc::new(sessions),
            operations: Arc::new(Semaphore::new(4)),
            runs: Arc::new(Semaphore::new(4)),
            streams: Arc::new(Semaphore::new(16)),
        }
    }
}
impl Drop for AgentState {
    fn drop(&mut self) {
        self.sessions.shutdown();
    }
}
pub(crate) fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Arc<AgentState>: FromRef<S>,
{
    Router::new()
        .route("/v1/agent/catalog", get(catalog))
        .route(
            "/v1/markdown-projects/{project}/agent/sessions",
            post(create),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}",
            get(read),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}/close",
            post(close),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}/turns",
            post(send),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}/turns/{turn}/cancel",
            post(cancel),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}/turns/{turn}/apply",
            post(apply),
        )
        .route(
            "/v1/markdown-projects/{project}/agent/sessions/{session}/turns/{turn}/events",
            get(events),
        )
}
fn error(code: &str) -> Response {
    api_error(
        match code {
            "AGENT_SESSION_NOT_FOUND" | "AGENT_TURN_NOT_FOUND" | "AGENT_PROPOSAL_NOT_FOUND" => {
                StatusCode::NOT_FOUND
            }
            "MARKDOWN_CONFLICT"
            | "AGENT_REQUEST_CONFLICT"
            | "AGENT_TURN_ACTIVE"
            | "AGENT_SESSION_CLOSED" => StatusCode::CONFLICT,
            "AGENT_BUSY" | "AGENT_UNAVAILABLE" => StatusCode::UNPROCESSABLE_ENTITY,
            "AGENT_STATE_UNAVAILABLE" | "MARKDOWN_STORAGE_UNAVAILABLE" => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        },
        code,
    )
}
async fn execute<T: serde::Serialize + Send + 'static>(
    state: Arc<AgentState>,
    op: impl FnOnce(&AgentSessions) -> Result<T> + Send + 'static,
) -> Response {
    let Ok(slot) = state.operations.clone().try_acquire_owned() else {
        return error("AGENT_BUSY");
    };
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        op(&state.sessions)
    })
    .await
    .unwrap_or(Err("AGENT_STATE_UNAVAILABLE"))
    {
        Ok(value) => Json(value).into_response(),
        Err(code) => error(code),
    }
}
async fn catalog(State(state): State<Arc<AgentState>>) -> Response {
    execute(state, |s| s.catalog()).await
}
async fn create(
    State(state): State<Arc<AgentState>>,
    Path(project): Path<String>,
    body: std::result::Result<Json<AgentCreateSession>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("AGENT_REQUEST_INVALID");
    };
    execute(state, move |s| s.create(&project, body)).await
}
async fn read(
    State(state): State<Arc<AgentState>>,
    Path((project, session)): Path<(String, String)>,
) -> Response {
    execute(state, move |s| s.read(&project, &session)).await
}
async fn close(
    State(state): State<Arc<AgentState>>,
    Path((project, session)): Path<(String, String)>,
) -> Response {
    execute(state, move |s| s.close(&project, &session)).await
}
async fn cancel(
    State(state): State<Arc<AgentState>>,
    Path((project, session, turn)): Path<(String, String, String)>,
) -> Response {
    execute(state, move |s| s.cancel(&project, &session, &turn)).await
}
async fn apply(
    State(state): State<Arc<AgentState>>,
    Path((project, session, turn)): Path<(String, String, String)>,
    body: std::result::Result<Json<AgentApply>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("AGENT_REQUEST_INVALID");
    };
    execute(state, move |s| {
        s.apply(&project, &session, &turn, &body.proposal_id)
    })
    .await
}
async fn send(
    State(state): State<Arc<AgentState>>,
    Path((project, session)): Path<(String, String)>,
    body: std::result::Result<Json<AgentSendTurn>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("AGENT_REQUEST_INVALID");
    };
    let runner = state.clone();
    execute(state, move |s| {
        let (turn, dispatch) = s.start(&project, &session, body)?;
        if let Some(dispatch) = dispatch {
            match runner.runs.clone().try_acquire_owned() {
                Ok(slot) => {
                    let sessions = runner.sessions.clone();
                    let project = project.clone();
                    let session = session.clone();
                    let turn_id = turn.id.clone();
                    tokio::runtime::Handle::current().spawn(async move {
                        let work = sessions.clone();
                        let mut task = tokio::task::spawn_blocking(move || { let _slot = slot; work.run(dispatch); });
                        tokio::select! {
                            result = &mut task => {
                                if result.is_err() { let _ = sessions.release_dispatch(&project, &session, &turn_id); let _ = sessions.finish(&project, &session, &turn_id, Err("AGENT_INTERRUPTED")); }
                            }
                            _ = tokio::time::sleep(TURN_TIMEOUT) => { let _ = sessions.finish(&project, &session, &turn_id, Err("AGENT_TIMEOUT")); }
                        }
                    });
                }
                Err(_) => { s.release_dispatch(&project, &session, &turn.id)?; s.finish(&project, &session, &turn.id, Err("AGENT_BUSY"))?; }
            }
        }
        Ok(turn)
    }).await
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(state): State<Arc<AgentState>>,
    Path((project, session, turn)): Path<(String, String, String)>,
    query: std::result::Result<Query<Cursor>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(query)) = query else {
        return error("AGENT_CURSOR_INVALID");
    };
    let Ok(slot) = state.streams.clone().try_acquire_owned() else {
        return error("AGENT_BUSY");
    };
    if let Err(code) = state
        .sessions
        .events(&project, &session, &turn, query.after)
    {
        return error(code);
    }
    let stream = futures_util::stream::unfold(
        (state, project, session, turn, query.after, false, slot),
        |(state, project, session, turn, mut after, done, slot)| async move {
            if done {
                return None;
            }
            loop {
                match state.sessions.events(&project, &session, &turn, after) {
                    Ok((events, settled)) => {
                        if !events.is_empty() {
                            // One bounded JSON page avoids retaining another unbounded channel per listener.
                            after += events.len() as i64;
                            let event = Event::default()
                                .event("agent")
                                .data(serde_json::to_string(&events).expect("serializable events"));
                            return Some((
                                Ok::<_, Infallible>(event),
                                (state, project, session, turn, after, settled, slot),
                            ));
                        }
                        if settled {
                            return None;
                        }
                    }
                    Err(_) => return None,
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        },
    );
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}
