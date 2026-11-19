use crate::*;
use axum::{extract::Path, routing::post};
use scenesparrow_application::ai::{AiExecutionPort, AiSettingsPort};
use scenesparrow_domain::{ai::AiError, contracts::*};
use scenesparrow_infrastructure::ai::{actions::SettingsActions, settings::SettingsStore};
use std::sync::OnceLock;

pub struct AiState {
    settings: OnceLock<Result<SettingsStore, AiError>>,
    actions: SettingsActions,
    slots: Arc<Semaphore>,
    pub(crate) blocking_slots: Arc<Semaphore>,
}
impl Default for AiState {
    fn default() -> Self {
        Self {
            settings: OnceLock::new(),
            actions: SettingsActions::default(),
            slots: Arc::new(Semaphore::new(1)),
            blocking_slots: Arc::new(Semaphore::new(4)),
        }
    }
}
impl AiState {
    pub(crate) fn settings(&self) -> Result<&SettingsStore, AiError> {
        self.settings
            .get_or_init(|| {
                SettingsStore::open(
                    &scenesparrow_infrastructure::ai::settings::app_data_directory(),
                )
            })
            .as_ref()
            .map_err(|e| *e)
    }
}
fn result<T: serde::Serialize>(result: Result<T, AiError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => api_error(
            match error.0 {
                "SETTINGS_CONFLICT" | "CONFIGURATION_STALE" | "REQUEST_ID_REUSED" => {
                    StatusCode::CONFLICT
                }
                "INPUT_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
                "STORAGE_UNAVAILABLE" => StatusCode::INTERNAL_SERVER_ERROR,
                _ => StatusCode::UNPROCESSABLE_ENTITY,
            },
            error.0,
        ),
    }
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/ai/settings", get(read).put(update))
        .route("/v1/ai/credentials", post(credential))
        .route("/v1/ai/credentials/delete", post(delete_credential))
        .route("/v1/ai/configuration", get(resolve))
        .route("/v1/ai/models/discover", post(discover))
        .route("/v1/ai/connection-tests", post(test))
        .route("/v1/ai/connection-tests/prepare", post(prepare_test))
        .route("/v1/ai/runs/{id}", get(read_run))
        .route("/v1/ai/runs/{id}/result", get(read_result))
        .route("/v1/ai/runs/{id}/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
}
async fn read(State(state): State<AppState>) -> Response {
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.ai.settings()?.read_settings()
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}
async fn resolve(State(state): State<AppState>) -> Response {
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state
                .ai
                .settings()?
                .resolve_configuration(AiCategory::Text, AiCapability::Textgenerate)
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}
async fn prepare_test(
    State(state): State<AppState>,
    body: Result<Json<AiTestTarget>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.ai.settings()?.resolve_test_configuration(&body)
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}
async fn update(
    State(state): State<AppState>,
    body: Result<Json<AiSettingsUpdate>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    let ai = state.ai;
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            ai.settings()?.update_settings(&body)
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}
async fn credential(
    State(state): State<AppState>,
    body: Result<Json<AiCredentialUpdate>, JsonRejection>,
) -> Response {
    let Ok(Json(mut body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    let ai = state.ai;
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            {
                let result = ai.settings()?.update_credential(
                    body.expected_revision,
                    &body.provider_id,
                    Some(&body.secret),
                );
                body.secret.clear();
                result
            }
        })
        .await
        .unwrap_or(Err(AiError("CREDENTIAL_UNAVAILABLE"))),
    )
}
async fn delete_credential(
    State(state): State<AppState>,
    body: Result<Json<AiCredentialUpdate>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if !body.secret.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    let ai = state.ai;
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            ai.settings()?
                .update_credential(body.expected_revision, &body.provider_id, None)
        })
        .await
        .unwrap_or(Err(AiError("CREDENTIAL_UNAVAILABLE"))),
    )
}
async fn discover(
    State(state): State<AppState>,
    body: Result<Json<AiModelAction>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(permit) = state.ai.slots.clone().try_acquire_owned() else {
        return api_error(StatusCode::CONFLICT, "QUEUE_FULL");
    };
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    let ai = state.ai;
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            {
                let _permit = permit;
                ai.actions.discover(ai.settings()?, &body.provider_id)
            }
        })
        .await
        .unwrap_or(Err(AiError("WORKER_INTERRUPTED"))),
    )
}
async fn test(
    State(state): State<AppState>,
    body: Result<Json<AiTestAction>, JsonRejection>,
) -> Response {
    let Ok(Json(body)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    // Identical concurrent action IDs wait on the same OnceLock receipt. The core
    // session owns this operation; HTTP timeout/reconnect never starts another ID.
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    let ai = state.ai;
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            ai.actions.test(ai.settings()?, &body)
        })
        .await
        .unwrap_or(Err(AiError("WORKER_INTERRUPTED"))),
    )
}
async fn read_run(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().read_run(&id)
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}
async fn read_result(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    match tokio::task::spawn_blocking(move || {
        let _slot = slot;
        state.service.repository().read_result(&id)
    })
    .await
    .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE")))
    {
        Ok(Some(bytes)) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "RESULT_UNAVAILABLE"),
        Err(e) => result::<()>(Err(e)),
    }
}
async fn cancel(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    // Future consumers register their coordinator here. Unknown owners fail closed;
    // there is no generic route that bypasses their applicability transaction.
    let Ok(slot) = state.ai.blocking_slots.clone().acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "QUEUE_FULL");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            state.service.repository().cancel_ai(&id, &[])
        })
        .await
        .unwrap_or(Err(AiError("STORAGE_UNAVAILABLE"))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_blocked_settings_file_does_not_block_manual_project_or_health_requests() {
        let directory = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let settings = SettingsStore::open(app_data.path()).unwrap();
        let ai = AiState::default();
        assert!(ai.settings.set(Ok(settings)).is_ok());
        let state = AppState {
            service: Arc::new(ProjectService::new(
                SqliteProjectRepository::open(directory.path()).unwrap(),
            )),
            authorization: "Bearer test-token".into(),
            allowed_origin: "http://127.0.0.1:5173".into(),
            database_slots: Arc::new(Semaphore::new(4)),
            document_slots: Arc::new(Semaphore::new(1)),
            ai: Arc::new(ai),
            native_authorization: None,
            transfers: Arc::new(std::sync::OnceLock::new()),
        };
        let app = crate::state_router(state);
        let file = std::fs::File::options()
            .read(true)
            .write(true)
            .open(app_data.path().join("ai-settings.lock"))
            .unwrap();
        file.lock().unwrap();
        let request = |path| {
            Request::builder()
                .uri(path)
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .unwrap()
        };
        let delayed = tokio::spawn(app.clone().oneshot(request("/v1/ai/settings")));
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(!delayed.is_finished());
        for path in ["/v1/health", "/v1/project"] {
            let response = tokio::time::timeout(
                std::time::Duration::from_millis(300),
                app.clone().oneshot(request(path)),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        drop(file);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), delayed)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
