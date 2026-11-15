use super::*;
use axum::extract::{Path, Query};
use scenesparrow_domain::manuscript::ManuscriptError;
#[derive(serde::Deserialize)]
struct Page {
    after: Option<String>,
    before: Option<i64>,
    offset: Option<usize>,
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/reviews", get(read))
        .route("/v1/manuscript/finalization", get(finalization))
        .route("/v1/reviews/{id}/messages", get(messages))
        .route("/v1/reviews/candidates/{id}", get(candidate))
        .route("/v1/reviews/comparisons/{id}", get(comparison))
}
async fn read(State(state): State<AppState>, Query(page): Query<Page>) -> Response {
    let Ok(slot) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state
                .service
                .repository()
                .read_reviews(page.after.as_deref())
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}

async fn messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    let Ok(slot) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().review_messages(&id, page.before)
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
async fn candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    let Ok(slot) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state
                .service
                .repository()
                .review_candidate(&id, page.offset.unwrap_or(0))
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}

async fn comparison(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(slot) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().review_source_comparison(&id)
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}

async fn finalization(State(state): State<AppState>) -> Response {
    let Ok(slot) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().read_finalization()
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
