use crate::*;
use axum::extract::{Path, Query};
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
    database(state, None, move |r| r.read_reviews(page.after.as_deref())).await
}

async fn messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    database(state, None, move |r| r.review_messages(&id, page.before)).await
}
async fn candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    database(state, None, move |r| {
        r.review_candidate(&id, page.offset.unwrap_or(0))
    })
    .await
}

async fn comparison(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| r.review_source_comparison(&id)).await
}

async fn finalization(State(state): State<AppState>) -> Response {
    database(state, None, |r| r.read_finalization()).await
}
