use crate::{api_error, authorize_request, contracts, observe_transport};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State, rejection::JsonRejection},
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
    authorization: String,
    origin: String,
}
pub fn router(root: &std::path::Path, token: &str, origin: &str) -> Result<Router, &'static str> {
    let state = FileState {
        store: Arc::new(MarkdownProjects::open(root)?),
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
async fn execute(
    state: FileState,
    op: impl FnOnce(&MarkdownProjects) -> Result<contracts::MarkdownProject, &'static str>
    + Send
    + 'static,
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
        store.save(&id, &body.revision, body.text)
    })
    .await
}
