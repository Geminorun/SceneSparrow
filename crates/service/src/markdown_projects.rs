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
    authorization: String,
    origin: String,
}
pub fn router(root: &std::path::Path, token: &str, origin: &str) -> Result<Router, &'static str> {
    let state = FileState {
        store: Arc::new(MarkdownProjects::open(root)?),
        ai: Arc::new(crate::ai::AiState::default()),
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
            "/v1/markdown-projects/{id}/exchange",
            get(download).post(review).layer(DefaultBodyLimit::max(
                scenesparrow_infrastructure::markdown_projects::MAX_EXCHANGE_BYTES,
            )),
        )
        .merge(crate::ai::settings_routes())
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
            let input = markdown_writing::input(&body)?;
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
}
async fn download(
    State(state): State<FileState>,
    Path(id): Path<String>,
    Query(query): Query<DownloadQuery>,
) -> Response {
    match tokio::task::spawn_blocking(move || state.store.exchange(&id, &query.revision))
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
