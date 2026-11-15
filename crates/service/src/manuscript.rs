use super::*;
use axum::{extract::Path, routing::post};
use scenesparrow_application::manuscript::ManuscriptRepository;
use scenesparrow_domain::{contracts::ManuscriptCommand, manuscript::ManuscriptError};
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/manuscript", get(read))
        .route("/v1/history", get(history))
        .route(
            "/v1/manuscript/commands",
            post(command).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/v1/commands/{request_id}", get(receipt))
}
pub(super) fn result<T: serde::Serialize>(
    value: Result<T, ManuscriptError>,
    request_id: Option<String>,
) -> Response {
    match value {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error.0 {
                "PROJECT_NOT_FOUND" | "OBJECT_NOT_FOUND" | "COMMAND_NOT_FOUND" => {
                    StatusCode::NOT_FOUND
                }
                "REVISION_CONFLICT" | "CONTENT_LOCKED" | "TASK_USING_CONTENT"
                | "HISTORY_CONFLICT" | "HISTORY_BLOCKED" | "IMPORT_STALE" => StatusCode::CONFLICT,
                "HISTORY_EMPTY"
                | "SOURCE_UNSUPPORTED"
                | "SOURCE_ENCRYPTED"
                | "SOURCE_TEXT_UNAVAILABLE"
                | "TEXT_ENCODING_UNSUPPORTED" => StatusCode::UNPROCESSABLE_ENTITY,
                "STORAGE_UNAVAILABLE" => StatusCode::INTERNAL_SERVER_ERROR,
                "DOCUMENT_TOO_LARGE" | "INPUT_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
                _ => StatusCode::BAD_REQUEST,
            };
            (
                status,
                Json(contracts::ApiError {
                    code: error.0.to_owned(),
                    details: error.1,
                    request_id,
                }),
            )
                .into_response()
        }
    }
}
async fn read(State(state): State<AppState>) -> Response {
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            state.service.repository().read_manuscript()
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
async fn history(State(state): State<AppState>) -> Response {
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            state.service.repository().read_history()
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
async fn receipt(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    let request_id = id.clone();
    result(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            state.service.repository().command_receipt(&id)
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        Some(request_id),
    )
}
async fn command(
    State(state): State<AppState>,
    body: Result<Json<ManuscriptCommand>, JsonRejection>,
) -> Response {
    let command = match body {
        Ok(Json(c)) => c,
        Err(rejection) => {
            return api_error(
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    StatusCode::PAYLOAD_TOO_LARGE
                } else {
                    StatusCode::BAD_REQUEST
                },
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "INPUT_TOO_LARGE"
                } else {
                    "INVALID_REQUEST"
                },
            );
        }
    };
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    let request_id = scenesparrow_domain::manuscript::envelope(&command)
        .0
        .to_owned();
    result(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            state.service.repository().execute_manuscript(&command)
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        Some(request_id),
    )
}
