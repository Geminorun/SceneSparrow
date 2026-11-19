//! Named capabilities over the registered project, never arbitrary paths.
use crate::*;
use scenesparrow_domain::contracts::AuthoredSourceSaveRequest;
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/format", get(inspect))
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
