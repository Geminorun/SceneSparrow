use crate::{api_error, contracts::*, markdown_projects::FileState};
use axum::{
    Json, Router,
    extract::{Path, Query, State, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use scenesparrow_infrastructure::markdown_projects::MarkdownProjects;

pub(crate) fn routes() -> Router<FileState> {
    Router::new()
        .route("/v1/markdown-projects/{id}/video", get(read).post(create))
        .route("/v1/markdown-projects/{id}/video/changes", post(change))
        .route("/v1/markdown-projects/{id}/video/decide", post(decide))
        .route(
            "/v1/markdown-projects/{id}/video/render",
            get(media).post(render),
        )
        .route("/v1/markdown-projects/{id}/video/export", get(export))
}
fn result<T: serde::Serialize>(value: Result<T, &'static str>) -> Response {
    match value {
        Ok(value) => Json(value).into_response(),
        Err(code) => error(code),
    }
}
fn error(code: &str) -> Response {
    api_error(
        match code {
            "VIDEO_CONFLICT" | "VIDEO_REQUEST_CONFLICT" | "VIDEO_PROPOSAL_PENDING" => {
                StatusCode::CONFLICT
            }
            "VIDEO_BUSY" => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        },
        code,
    )
}
async fn execute<T: serde::Serialize + Send + 'static>(
    state: FileState,
    op: impl FnOnce(&MarkdownProjects) -> Result<T, &'static str> + Send + 'static,
) -> Response {
    let Ok(slot) = state.video_slots.try_acquire_owned() else {
        return error("VIDEO_BUSY");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            op(&state.store)
        })
        .await
        .unwrap_or(Err("VIDEO_WORKER_FAILED")),
    )
}
async fn read(State(state): State<FileState>, Path(id): Path<String>) -> Response {
    result(
        tokio::task::spawn_blocking(move || state.store.video_read(&id))
            .await
            .unwrap_or(Err("VIDEO_WORKER_FAILED")),
    )
}
async fn create(State(state): State<FileState>, Path(id): Path<String>) -> Response {
    execute(state, move |store| store.video_create(&id)).await
}
async fn change(
    State(state): State<FileState>,
    Path(id): Path<String>,
    body: Result<Json<VideoRequestChange>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("VIDEO_REQUEST_INVALID");
    };
    let agent = state.video_agent.clone();
    execute(state, move |store| {
        store.video_request(&id, body, agent.as_ref())
    })
    .await
}
async fn decide(
    State(state): State<FileState>,
    Path(id): Path<String>,
    body: Result<Json<VideoDecision>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("VIDEO_REQUEST_INVALID");
    };
    execute(state, move |store| store.video_decide(&id, body)).await
}
async fn render(
    State(state): State<FileState>,
    Path(id): Path<String>,
    body: Result<Json<VideoRender>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return error("VIDEO_REQUEST_INVALID");
    };
    execute(state, move |store| store.video_render(&id, &body.revision)).await
}
async fn bytes(state: FileState, id: String, revision: String, export: bool) -> Response {
    let Ok(slot) = state.video_slots.try_acquire_owned() else {
        return error("VIDEO_BUSY");
    };
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        if export {
            state.store.video_export(&id, &revision)
        } else {
            state.store.video_media(&id, &revision)
        }
    })
    .await
    .unwrap_or(Err("VIDEO_WORKER_FAILED"))
    {
        Ok(value) => (
            [
                (
                    "content-type",
                    if export {
                        "application/zip"
                    } else {
                        "video/mp4"
                    },
                ),
                ("cache-control", "no-store"),
                (
                    "content-disposition",
                    if export {
                        "attachment; filename=\"scenesparrow-video.zip\""
                    } else {
                        "inline"
                    },
                ),
            ],
            value,
        )
            .into_response(),
        Err(code) => error(code),
    }
}
async fn media(
    State(state): State<FileState>,
    Path(id): Path<String>,
    Query(query): Query<VideoRender>,
) -> Response {
    bytes(state, id, query.revision, false).await
}
async fn export(
    State(state): State<FileState>,
    Path(id): Path<String>,
    Query(query): Query<VideoRender>,
) -> Response {
    bytes(state, id, query.revision, true).await
}
