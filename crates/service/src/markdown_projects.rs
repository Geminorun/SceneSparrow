use crate::{api_error, authorize_request, contracts, observe_transport};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, FromRef, Path, Query, Request, State, rejection::JsonRejection},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use scenesparrow_infrastructure::markdown_projects::MarkdownProjects;
use std::sync::Arc;
#[derive(Clone)]
struct FileState {
    store: Arc<MarkdownProjects>,
    ai: Arc<crate::ai::AiState>,
    agent: Arc<crate::external_agent::AgentState>,
    authorization: String,
    origin: String,
}
pub fn router(root: &std::path::Path, token: &str, origin: &str) -> Result<Router, &'static str> {
    let ai = Arc::new(crate::ai::AiState::default());
    let credentials = ai.clone();
    let adapter = scenesparrow_infrastructure::deepseek_agent::WritingAgents {
        codex: scenesparrow_infrastructure::codex_agent::CodexAgent::configured(),
        deepseek: scenesparrow_infrastructure::deepseek_agent::DeepSeekAgent::new(
            std::env::var_os("SCENESPARROW_DEEPSEEK_SOCKET").map(Into::into),
            Arc::new(move || {
                credentials
                    .settings()
                    .and_then(|s| s.lease_official_deepseek())
                    .map_err(|e| {
                        if e.0 == "CREDENTIAL_UNAVAILABLE" {
                            "AGENT_DEEPSEEK_CREDENTIAL_REQUIRED"
                        } else {
                            "AGENT_STATE_UNAVAILABLE"
                        }
                    })
            }),
        ),
    };
    router_with_state(root, token, origin, Arc::new(adapter), ai)
}
/// Explicit dependency injection for ordinary deterministic fixtures.
pub fn router_with_agent(
    root: &std::path::Path,
    token: &str,
    origin: &str,
    adapter: Arc<dyn scenesparrow_application::external_agent::WritingAgent>,
) -> Result<Router, &'static str> {
    router_with_state(
        root,
        token,
        origin,
        adapter,
        Arc::new(crate::ai::AiState::default()),
    )
}
fn router_with_state(
    root: &std::path::Path,
    token: &str,
    origin: &str,
    adapter: Arc<dyn scenesparrow_application::external_agent::WritingAgent>,
    ai: Arc<crate::ai::AiState>,
) -> Result<Router, &'static str> {
    let store = Arc::new(MarkdownProjects::open(root)?);
    let agent = Arc::new(crate::external_agent::AgentState::new(
        scenesparrow_application::external_agent::AgentSessions::new(store.clone(), adapter),
    ));
    let weak_agent = Arc::downgrade(&agent);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let Some(agent) = weak_agent.upgrade() else {
                break;
            };
            let _ = tokio::task::spawn_blocking(move || agent.sessions.expire()).await;
        }
    });
    let state = FileState {
        store,
        agent,
        ai,
        authorization: format!("Bearer {token}"),
        origin: origin.into(),
    };
    Ok(Router::new()
        .route(
            "/v1/health",
            get(|| async {
                Json(contracts::Health {
                    status: "ok".into(),
                    protocol_version: "0.1.0".into(),
                    markdown_projects: Some(true),
                })
            }),
        )
        .route("/v1/markdown-projects", post(create))
        .route("/v1/markdown-projects/{id}", get(read).post(save))
        .route("/v1/markdown-projects/{id}/writing", post(writing))
        .route(
            "/v1/markdown-projects/{id}/documents/{kind}",
            get(read_document).post(save_document),
        )
        .route(
            "/v1/markdown-projects/{id}/documents/{kind}/annotations",
            get(annotations).post(annotate),
        )
        .route(
            "/v1/markdown-projects/{id}/documents/{kind}/scoped",
            post(scoped),
        )
        .route(
            "/v1/markdown-projects/{id}/documents/{kind}/scoped/apply",
            post(apply_scoped),
        )
        .route(
            "/v1/markdown-projects/{id}/exchange",
            get(download).post(review).layer(DefaultBodyLimit::max(
                scenesparrow_infrastructure::markdown_projects::MAX_EXCHANGE_BYTES,
            )),
        )
        .merge(crate::ai::settings_routes())
        .merge(crate::external_agent::routes())
        .fallback(|| async { api_error(StatusCode::NOT_FOUND, "NOT_FOUND") })
        // A 2 MiB UTF-8 manuscript can occupy six times as much JSON when escaped.
        .layer(DefaultBodyLimit::max(
            6 * scenesparrow_domain::manuscript::MAX_TEXT_BYTES + 4096,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .layer(middleware::from_fn(observe_transport))
        .with_state(state))
}
async fn authorize(State(state): State<FileState>, request: Request, next: Next) -> Response {
    if let Some(response) = authorize_request(&request, &state.authorization, &state.origin) {
        return response;
    }
    next.run(request).await
}
async fn execute<T: serde::Serialize + Send + 'static>(
    state: FileState,
    op: impl FnOnce(&MarkdownProjects) -> Result<T, &'static str> + Send + 'static,
) -> Response {
    match tokio::task::spawn_blocking(move || op(&state.store))
        .await
        .unwrap_or(Err("MARKDOWN_STORAGE_UNAVAILABLE"))
    {
        Ok(value) => Json(value).into_response(),
        Err(code) => api_error(
            match code {
                "MARKDOWN_CONFLICT" => StatusCode::CONFLICT,
                "MARKDOWN_STORAGE_UNAVAILABLE" => StatusCode::INTERNAL_SERVER_ERROR,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            },
            code,
        ),
    }
}
async fn create(
    State(state): State<FileState>,
    body: Result<Json<contracts::CreateMarkdownProject>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_TEXT_INVALID");
    };
    execute(state, move |store| store.create(body.text)).await
}
async fn read(State(state): State<FileState>, Path(id): Path<String>) -> Response {
    execute(state, move |store| store.read(&id)).await
}
async fn save(
    State(state): State<FileState>,
    Path(id): Path<String>,
    body: Result<Json<contracts::SaveMarkdownProject>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_TEXT_INVALID");
    };
    execute(state, move |store| {
        store.save_with_outline(
            &id,
            &body.revision,
            body.text,
            body.outline_revision.as_deref(),
        )
    })
    .await
}

async fn read_document(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
) -> Response {
    execute(state, move |store| store.read_document(&id, kind)).await
}
async fn save_document(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
    body: Result<Json<contracts::SaveMarkdownDocument>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_TEXT_INVALID");
    };
    execute(state, move |store| {
        store.save_document(&id, kind, body.revision.as_deref(), body.text)
    })
    .await
}

impl FromRef<FileState> for Arc<crate::ai::AiState> {
    fn from_ref(state: &FileState) -> Self {
        state.ai.clone()
    }
}
async fn writing(
    State(state): State<FileState>,
    Path(id): Path<String>,
    body: Result<Json<scenesparrow_domain::contracts::MarkdownWritingAction>, JsonRejection>,
) -> Response {
    use scenesparrow_application::markdown_writing;
    use scenesparrow_domain::{
        ai::{AiError, ensure},
        contracts::MarkdownWritingResult,
    };
    let Ok(Json(mut body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().try_acquire_owned() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    crate::ai::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let outline_revision = if body.kind == contracts::MarkdownWritingActionKind::Draft {
                ensure(body.outline_revision.is_some(), "MARKDOWN_WRITING_INVALID")?;
                body.outline_revision.as_deref()
            } else {
                None
            };
            let outline = state
                .store
                .writing_snapshot(&id, &body.revision, outline_revision)
                .map_err(AiError)?;
            if let Some(outline) = outline {
                body.outline = outline.text;
            }
            let target = if body.kind == contracts::MarkdownWritingActionKind::Outline {
                contracts::MarkdownDocumentKind::Outline
            } else {
                contracts::MarkdownDocumentKind::Manuscript
            };
            let annotations = state.store.annotations(&id, target).map_err(AiError)?;
            let mut protected = std::collections::BTreeSet::new();
            for lock in annotations.locks {
                for anchor in lock.anchors {
                    ensure(anchor.resolved_start.is_some(), "MARKDOWN_LOCK_CONFLICT")?;
                    protected.insert(anchor.quote);
                }
            }
            let input = markdown_writing::input(&body, &protected.into_iter().collect::<Vec<_>>())?;
            let context =
                serde_json::to_string(&(&id, &body)).map_err(|_| AiError("INVALID_REQUEST"))?;
            let text = state.ai.actions.text(
                state.ai.settings()?,
                scenesparrow_infrastructure::ai::actions::TextAction {
                    action_id: &body.action_id,
                    session_id: &body.session_id,
                    fingerprint: &body.fingerprint,
                    context: &context,
                    input: &input,
                },
            )?;
            markdown_writing::validate_output(&text)?;
            Ok(MarkdownWritingResult {
                action_id: body.action_id,
                text,
            })
        })
        .await
        .unwrap_or(Err(AiError("WORKER_INTERRUPTED"))),
    )
}

#[derive(serde::Deserialize)]
struct DownloadQuery {
    revision: String,
    #[serde(rename = "outlineRevision")]
    outline_revision: String,
}
async fn download(
    State(state): State<FileState>,
    Path(id): Path<String>,
    Query(query): Query<DownloadQuery>,
) -> Response {
    match tokio::task::spawn_blocking(move || {
        state.store.exchange(
            &id,
            &query.revision,
            if query.outline_revision == "absent" {
                None
            } else {
                Some(&query.outline_revision)
            },
        )
    })
    .await
    .unwrap_or(Err("MARKDOWN_STORAGE_UNAVAILABLE"))
    {
        Ok(bytes) => (
            [
                ("content-type", "application/zip"),
                (
                    "content-disposition",
                    "attachment; filename=\"scenesparrow-project.zip\"",
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(code) => api_error(
            if code == "MARKDOWN_CONFLICT" {
                StatusCode::CONFLICT
            } else if code == "MARKDOWN_STORAGE_UNAVAILABLE" {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            },
            code,
        ),
    }
}
async fn review(
    State(state): State<FileState>,
    Path(id): Path<String>,
    bytes: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let Ok(bytes) = bytes else {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "MARKDOWN_EXCHANGE_INVALID",
        );
    };
    execute(state, move |store| {
        store.review_exchange(&id, bytes.to_vec())
    })
    .await
}

async fn annotations(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
) -> Response {
    execute(state, move |store| store.annotations(&id, kind)).await
}
async fn annotate(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
    body: Result<Json<contracts::MarkdownAnnotationAction>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_ANCHOR_INVALID");
    };
    execute(state, move |store| store.annotate(&id, kind, body)).await
}
async fn apply_scoped(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
    body: Result<Json<contracts::MarkdownScopedApply>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_ANCHOR_INVALID");
    };
    execute(state, move |store| store.apply_scoped(&id, kind, body)).await
}
async fn scoped(
    State(state): State<FileState>,
    Path((id, kind)): Path<(String, contracts::MarkdownDocumentKind)>,
    body: Result<Json<contracts::MarkdownScopedAction>, JsonRejection>,
) -> Response {
    use scenesparrow_domain::ai::AiError;
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "MARKDOWN_ANCHOR_INVALID");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().try_acquire_owned() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    crate::ai::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            let (scope, instruction, range, fingerprint) = state
                .store
                .scoped_snapshot(&id, kind.clone(), &body.revision, &body.comment_id)
                .map_err(AiError)?;
            let input =
                scenesparrow_application::markdown_writing::scoped_input(&scope, &instruction)?;
            let context = serde_json::to_string(&(
                &id,
                kind,
                &body,
                &scope,
                &instruction,
                &range,
                &fingerprint,
            ))
            .map_err(|_| AiError("INVALID_REQUEST"))?;
            let text = state.ai.actions.text(
                state.ai.settings()?,
                scenesparrow_infrastructure::ai::actions::TextAction {
                    action_id: &body.action_id,
                    session_id: &body.session_id,
                    fingerprint: &body.fingerprint,
                    context: &context,
                    input: &input,
                },
            )?;
            scenesparrow_application::markdown_writing::validate_output(&text)?;
            Ok(contracts::MarkdownScopedResult {
                action_id: body.action_id,
                text,
                range,
                fingerprint,
            })
        })
        .await
        .unwrap_or(Err(AiError("WORKER_INTERRUPTED"))),
    )
}

impl FromRef<FileState> for Arc<crate::external_agent::AgentState> {
    fn from_ref(state: &FileState) -> Self {
        state.agent.clone()
    }
}
