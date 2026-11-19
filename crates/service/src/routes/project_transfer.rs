//! Named lifecycle operations scoped to the currently owned legacy source.
use crate::*;
use axum::{extract::Path, routing::post};
use scenesparrow_domain::contracts::{
    LegacyMigrationRequest, MigrationControlRequest, MigrationTargetRequest,
};
use scenesparrow_infrastructure::project_transfer::ProjectTransferStore;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/migration", get(inspect))
        .route("/v1/project/migration-targets", post(target))
        .route("/v1/project/migrations", post(start))
        .route("/v1/project/migrations/{id}", get(status))
        .route("/v1/project/migrations/{id}/control", post(control))
}
pub(crate) fn store(state: &AppState) -> Result<Arc<ProjectTransferStore>, ManuscriptError> {
    state
        .transfers
        .get_or_init(|| {
            ProjectTransferStore::open_default()
                .map(Arc::new)
                .map_err(|e| e.0)
        })
        .clone()
        .map_err(|e| ManuscriptError(e, None))
}
async fn inspect(State(state): State<AppState>) -> Response {
    database(state, None, |r| r.inspect_legacy_migration()).await
}
async fn target(
    State(state): State<AppState>,
    body: Result<Json<MigrationTargetRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let store = match store(&state) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), Some(request.request_id)),
    };
    database(state, Some(request.request_id.clone()), move |r| {
        store.issue_target(r, &request)
    })
    .await
}
async fn start(
    State(state): State<AppState>,
    body: Result<Json<LegacyMigrationRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let store = match store(&state) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), Some(request.request_id)),
    };
    database(state, Some(request.request_id.clone()), move |r| {
        store.start(r, &request)
    })
    .await
}
async fn status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match store(&state) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    database(state, None, move |r| store.status(r, &id)).await
}
async fn control(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<MigrationControlRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let store = match store(&state) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), Some(request.request_id)),
    };
    database(state, Some(request.request_id.clone()), move |r| {
        store.control(r, &id, &request)
    })
    .await
}
