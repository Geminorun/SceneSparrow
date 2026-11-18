use crate::*;
use axum::{extract::Path, routing::post};
use scenesparrow_domain::{contracts::*, manuscript::ManuscriptError};
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/planning", get(read))
        .route("/v1/planning/preparations", post(prepare))
        .route("/v1/planning/tasks/{id}", get(task))
        .route("/v1/planning/visuals", post(visual))
        .route(
            "/v1/planning/visuals/{id}",
            get(read_visual).delete(cancel_visual),
        )
}

async fn read(State(state): State<AppState>) -> Response {
    database(state, None, |r| r.read_planning()).await
}
async fn task(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| r.planning_task(&id)).await
}
async fn prepare(
    State(state): State<AppState>,
    body: Result<Json<PlanningPreparationRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().prepare_planning(
                state
                    .ai
                    .settings()
                    .map_err(|e| ManuscriptError(e.0, None))?,
                &body,
            )
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
async fn visual(
    State(state): State<AppState>,
    body: Result<Json<PlanningVisualAction>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let id = body.id.clone();
    let repository = state.service.clone();
    let result =
        tokio::task::spawn_blocking(move || repository.repository().begin_planning_visual(&body))
            .await
            .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)));
    if result.as_ref().is_ok_and(|v| v.status == "queued") {
        tokio::spawn(async move {
            let Ok(_slot) = state.document_slots.acquire_owned().await else {
                return;
            };
            let _ = tokio::task::spawn_blocking(move || {
                state.service.repository().run_planning_visual(&id)
            })
            .await;
        });
    }
    manuscript::result(result, None)
}
async fn read_visual(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    manuscript::result(
        tokio::task::spawn_blocking(move || state.service.repository().planning_visual(&id))
            .await
            .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
async fn cancel_visual(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    manuscript::result(
        tokio::task::spawn_blocking(move || state.service.repository().cancel_planning_visual(&id))
            .await
            .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        None,
    )
}
