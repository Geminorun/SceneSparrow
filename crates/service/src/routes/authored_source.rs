//! Named capabilities over the registered project, never arbitrary paths.
use crate::*;
use axum::{extract::Path, routing::post};
use scenesparrow_domain::contracts::{
    AuthoredSourceRecoverRequest, AuthoredSourceRescanRequest, AuthoredSourceResolveRequest,
    AuthoredSourceSaveRequest,
};
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/format", get(inspect))
        .route("/v1/manuscript/source/status", get(status))
        .route("/v1/manuscript/source/rescan", post(rescan))
        .route("/v1/manuscript/source/candidates/{id}", get(candidate))
        .route("/v1/manuscript/source/recover", post(recover))
        .route(
            "/v1/manuscript/source/recoveries/{intent}/evidence",
            get(recovery_evidence),
        )
        .route(
            "/v1/manuscript/source/recoveries/{intent}/evidence/{source}",
            get(recovery_bytes),
        )
        .route(
            "/v1/manuscript/source/resolve",
            post(resolve).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/v1/manuscript/source",
            get(read)
                .post(save)
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
}
async fn inspect(State(state): State<AppState>) -> Response {
    database(state, None, |repository| {
        repository.inspect_registered_format()
    })
    .await
}
async fn read(State(state): State<AppState>) -> Response {
    database(state, None, |repository| repository.read_source_snapshot()).await
}
async fn save(
    State(state): State<AppState>,
    body: Result<Json<AuthoredSourceSaveRequest>, JsonRejection>,
) -> Response {
    let request = match body {
        Ok(Json(request)) => request,
        Err(error) => {
            return api_error(
                if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    StatusCode::PAYLOAD_TOO_LARGE
                } else {
                    StatusCode::BAD_REQUEST
                },
                if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "INPUT_TOO_LARGE"
                } else {
                    "INVALID_REQUEST"
                },
            );
        }
    };
    database(state, Some(request.request_id.clone()), move |repository| {
        repository.save_source(&request)
    })
    .await
}

async fn status(State(state): State<AppState>) -> Response {
    database(state, None, |r| r.source_status()).await
}
async fn rescan(
    State(state): State<AppState>,
    body: Result<Option<Json<AuthoredSourceRescanRequest>>, JsonRejection>,
) -> Response {
    if body.is_err() {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    database(state, None, |r| r.rescan_source()).await
}
async fn candidate(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| r.source_candidate(&id)).await
}
async fn recover(
    State(state): State<AppState>,
    body: Result<Json<AuthoredSourceRecoverRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(state, None, move |r| r.recover_source(&request)).await
}
async fn resolve(
    State(state): State<AppState>,
    body: Result<Json<AuthoredSourceResolveRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(state, Some(request.request_id.clone()), move |r| {
        r.resolve_source(&request)
    })
    .await
}

async fn recovery_evidence(State(state): State<AppState>, Path(intent): Path<String>) -> Response {
    database(state, None, move |r| r.source_recovery_evidence(&intent)).await
}
async fn recovery_bytes(
    State(state): State<AppState>,
    Path((intent, source)): Path<(String, String)>,
) -> Response {
    database(state, None, move |r| {
        r.source_recovery_bytes(&intent, &source)
    })
    .await
}
