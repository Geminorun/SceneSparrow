pub mod contracts;
mod jobs;
pub mod markdown_projects;
mod routes;

use routes::{ai, manuscript};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use scenesparrow_application::{Error, ProjectService};
use scenesparrow_domain::manuscript::ManuscriptError;
use scenesparrow_infrastructure::SqliteProjectRepository;
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Clone)]
struct AppState {
    service: Arc<ProjectService<SqliteProjectRepository>>,
    authorization: String,
    allowed_origin: String,
    database_slots: Arc<Semaphore>,
    document_slots: Arc<Semaphore>,
    ai: Arc<ai::AiState>,
    native_authorization: Option<String>,
}

async fn database<T: serde::Serialize + Send + 'static>(
    state: AppState,
    request_id: Option<String>,
    op: impl FnOnce(&SqliteProjectRepository) -> Result<T, ManuscriptError> + Send + 'static,
) -> Response {
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    };
    manuscript::result(
        tokio::task::spawn_blocking(move || {
            // Blocking work outlives a cancelled HTTP future, so it owns the slot.
            let _permit = permit;
            op(state.service.repository())
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None))),
        request_id,
    )
}

pub fn router(repository: SqliteProjectRepository, token: &str, allowed_origin: &str) -> Router {
    let state = AppState {
        service: Arc::new(ProjectService::new(repository)),
        authorization: format!("Bearer {token}"),
        allowed_origin: allowed_origin.to_owned(),
        database_slots: Arc::new(Semaphore::new(4)),
        document_slots: Arc::new(Semaphore::new(1)),
        ai: Arc::new(ai::AiState::default()),
        native_authorization: std::env::var("SCENESPARROW_NATIVE_TOKEN").ok(),
    };
    jobs::start(&state);
    state_router(state)
}
fn state_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/project", get(read_project).post(create_project))
        .route("/v1/project/ensure", axum::routing::post(ensure_project))
        .route("/v1/project/rename", axum::routing::post(rename_project))
        .merge(routes::routes())
        .fallback(|| async { api_error(StatusCode::NOT_FOUND, "NOT_FOUND") })
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .layer(middleware::from_fn(observe_transport))
        .with_state(state)
}

// Transport correlation is separate from business request/idempotency identities.
async fn observe_transport(request: Request, next: Next) -> Response {
    use scenesparrow_infrastructure::diagnostics::{self, Event};
    let trace = request
        .headers()
        .get("x-scenesparrow-trace-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| diagnostics::valid_transport_trace(v))
        .map(str::to_owned);
    let started = std::time::Instant::now();
    let mut response = next.run(request).await;
    if let Some(trace) = &trace {
        response.headers_mut().insert(
            "x-scenesparrow-trace-id",
            trace.parse().expect("validated ASCII trace"),
        );
    }
    diagnostics::emit_record(
        Event::CoreRequest,
        trace.as_deref(),
        Some(response.status().as_u16()),
        Some(started.elapsed().as_millis()),
        None,
        None,
    );
    response
}

fn api_error(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(contracts::ApiError {
            code: code.to_owned(),
            details: None,
            request_id: None,
        }),
    )
        .into_response()
}

fn authorize_request(
    request: &Request,
    authorization: &str,
    allowed_origin: &str,
) -> Option<Response> {
    if request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        != Some(authorization)
    {
        return Some(api_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    if let Some(origin) = request.headers().get("origin")
        && origin.to_str().ok() != Some(allowed_origin)
    {
        return Some(api_error(StatusCode::FORBIDDEN, "ORIGIN_DENIED"));
    }
    None
}

async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if let Some(response) = authorize_request(&request, &state.authorization, &state.allowed_origin)
    {
        return response;
    }
    let native = request
        .uri()
        .path()
        .starts_with("/v1/manuscript/deliveries")
        || request.uri().path().starts_with("/v1/project/quiesce")
        || request.uri().path().starts_with("/v1/project/resume")
        || request.uri().path().starts_with("/v1/project/backup");
    if native
        && (state.native_authorization.is_none()
            || request
                .headers()
                .get("x-scenesparrow-native")
                .and_then(|v| v.to_str().ok())
                != state.native_authorization.as_deref())
    {
        return api_error(StatusCode::FORBIDDEN, "ORIGIN_DENIED");
    }
    if state.service.repository().is_quiescing()
        && request.method() != axum::http::Method::GET
        && !request.uri().path().ends_with("/quiesce")
        && !request.uri().path().ends_with("/resume")
    {
        return api_error(StatusCode::CONFLICT, "PROJECT_CLOSING");
    }
    next.run(request).await
}

async fn health() -> Json<contracts::Health> {
    Json(contracts::Health {
        markdown_projects: None,
        protocol_version: "0.1.0".to_owned(),
        status: "ok".to_owned(),
    })
}

fn to_contract(project: scenesparrow_domain::Project) -> contracts::Project {
    contracts::Project {
        id: project.id,
        title: project.title,
        working_revision: project.working_revision,
        approved_baseline: project.approved_baseline,
    }
}

fn result_response(result: Result<Option<scenesparrow_domain::Project>, Error>) -> Response {
    match result {
        Ok(project) => Json(contracts::ProjectResponse {
            project: project.map(to_contract),
        })
        .into_response(),
        Err(Error::InvalidTitle) => api_error(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_TITLE"),
        Err(Error::InvalidRequest) => {
            api_error(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_REQUEST")
        }
        Err(Error::Conflict) => api_error(StatusCode::CONFLICT, "PROJECT_CONFLICT"),
        Err(Error::Closing) => api_error(StatusCode::CONFLICT, "PROJECT_CLOSING"),
        Err(Error::SchemaUnsupported) => {
            api_error(StatusCode::SERVICE_UNAVAILABLE, "SCHEMA_UNSUPPORTED")
        }
        Err(Error::Storage) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "STORAGE_UNAVAILABLE"),
    }
}

async fn read_project(State(state): State<AppState>) -> Response {
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state.service.read()
    })
    .await;
    result_response(result.unwrap_or(Err(Error::Storage)))
}

async fn create_project(
    State(state): State<AppState>,
    body: Result<Json<contracts::CreateProject>, JsonRejection>,
) -> Response {
    let Ok(Json(command)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state
            .service
            .create(&command.request_id, &command.title)
            .map(Some)
    })
    .await;
    result_response(result.unwrap_or(Err(Error::Storage)))
}

async fn ensure_project(
    State(state): State<AppState>,
    body: Result<Json<contracts::EnsureProject>, JsonRejection>,
) -> Response {
    let Ok(Json(command)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state
            .service
            .ensure(&command.request_id, &command.title)
            .map(Some)
    })
    .await;
    result_response(result.unwrap_or(Err(Error::Storage)))
}

async fn rename_project(
    State(state): State<AppState>,
    body: Result<Json<contracts::RenameProject>, JsonRejection>,
) -> Response {
    let Ok(Json(command)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let Ok(permit) = state.database_slots.acquire_owned().await else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        state
            .service
            .rename(
                &command.request_id,
                &command.project_id,
                &command.previous_title,
                &command.title,
            )
            .map(Some)
    })
    .await;
    result_response(result.unwrap_or(Err(Error::Storage)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn database_work_retains_its_slot_after_http_cancellation_and_maps_errors() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState {
            service: Arc::new(ProjectService::new(
                SqliteProjectRepository::open(directory.path()).unwrap(),
            )),
            authorization: "Bearer test-token".into(),
            allowed_origin: "http://127.0.0.1:5173".into(),
            database_slots: Arc::new(Semaphore::new(1)),
            document_slots: Arc::new(Semaphore::new(1)),
            ai: Arc::new(ai::AiState::default()),
            native_authorization: None,
        };
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first = tokio::spawn(database(state.clone(), None, move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(contracts::EmptyPayload {})
        }));
        tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert_eq!(state.database_slots.available_permits(), 0);
        let (second_started_tx, mut second_started_rx) = tokio::sync::oneshot::channel();
        let second = tokio::spawn(database(
            state.clone(),
            Some("receipt-id".into()),
            move |_| {
                second_started_tx.send(()).unwrap();
                Err::<contracts::EmptyPayload, _>(ManuscriptError(
                    "REVISION_CONFLICT",
                    Some(contracts::HistoryErrorDetails {
                        reason: "CONTENT_LOCKED".into(),
                        affected_ids: vec!["block-id".into()],
                        candidate_conflicts: None,
                    }),
                ))
            },
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut second_started_rx,)
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap();
        second_started_rx.await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
        let error: contracts::ApiError = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error.code, "REVISION_CONFLICT");
        assert_eq!(error.request_id.as_deref(), Some("receipt-id"));
        assert_eq!(
            error.details,
            Some(contracts::HistoryErrorDetails {
                reason: "CONTENT_LOCKED".into(),
                affected_ids: vec!["block-id".into()],
                candidate_conflicts: None,
            })
        );
        assert_eq!(state.database_slots.available_permits(), 1);

        let response = database::<contracts::EmptyPayload>(
            state.clone(),
            Some("panicked-request".into()),
            |_| panic!("simulated blocking worker panic"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
        let error: contracts::ApiError = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error.code, "STORAGE_UNAVAILABLE");
        assert_eq!(error.request_id.as_deref(), Some("panicked-request"));
        assert_eq!(state.database_slots.available_permits(), 1);

        state.database_slots.close();
        let response =
            database::<contracts::EmptyPayload>(state, Some("unstarted-request".into()), |_| {
                panic!("closed semaphore must not run work")
            })
            .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
        let error: contracts::ApiError = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error.code, "STORAGE_UNAVAILABLE");
        assert_eq!(error.request_id, None);
    }

    async fn project_post(app: Router, path: &str, body: serde_json::Value) -> Response {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", "Bearer test-token")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn ensure_and_rename_authenticate_validate_and_keep_one_identity() {
        use serde_json::json;
        let directory = tempfile::tempdir().unwrap();
        let app = router(
            SqliteProjectRepository::open(directory.path()).unwrap(),
            "test-token",
            "http://127.0.0.1:5173",
        );
        for path in ["/v1/project/ensure", "/v1/project/rename"] {
            for (auth, origin, expected) in [
                (None, None, StatusCode::UNAUTHORIZED),
                (
                    Some("Bearer test-token"),
                    Some("https://other.example"),
                    StatusCode::FORBIDDEN,
                ),
            ] {
                let mut request = Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json");
                if let Some(auth) = auth {
                    request = request.header("authorization", auth);
                }
                if let Some(origin) = origin {
                    request = request.header("origin", origin);
                }
                let response = app
                    .clone()
                    .oneshot(
                        request
                            .body(Body::from(
                                r#"{"requestId":"first","title":"Untitled project"}"#,
                            ))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected);
            }
        }
        for (body, expected) in [
            (json!({"title":"Missing request"}), StatusCode::BAD_REQUEST),
            (
                json!({"requestId":"x","title":"Untitled","path":"/tmp/other"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"requestId":"bad request","title":"Untitled"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                json!({"requestId":"first","title":" "}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                json!({"requestId":"first","title":"雀".repeat(121)}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            assert_eq!(
                project_post(app.clone(), "/v1/project/ensure", body)
                    .await
                    .status(),
                expected
            );
        }
        let mut tasks = tokio::task::JoinSet::new();
        for n in 0..8 {
            let app = app.clone();
            tasks.spawn(async move {
                let response = project_post(
                    app,
                    "/v1/project/ensure",
                    json!({"requestId":format!("first-{n}"),"title":format!("Untitled {n}")}),
                )
                .await;
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
                serde_json::from_slice::<contracts::ProjectResponse>(&bytes)
                    .unwrap()
                    .project
                    .unwrap()
            });
        }
        let mut projects = vec![];
        while let Some(result) = tasks.join_next().await {
            projects.push(result.unwrap());
        }
        assert!(projects.iter().all(|p| p == &projects[0]));
        let project = &projects[0];
        let rename = json!({"requestId":"rename-one","projectId":project.id,"previousTitle":project.title,"title":"Saved name 中文"});
        for (body, expected) in [
            (
                json!({"requestId":"missing","projectId":project.id,"title":"New"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                json!({"requestId":"invalid","projectId":"wrong","previousTitle":project.title,"title":"New"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                json!({"requestId":"mismatch","projectId":"00000000-0000-4000-8000-000000000001","previousTitle":project.title,"title":"New"}),
                StatusCode::CONFLICT,
            ),
            (
                json!({"requestId":"empty","projectId":project.id,"previousTitle":project.title,"title":""}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (rename.clone(), StatusCode::OK),
            (rename.clone(), StatusCode::OK),
            (
                json!({"requestId":"rename-one","projectId":project.id,"previousTitle":project.title,"title":"Changed payload"}),
                StatusCode::CONFLICT,
            ),
            (
                json!({"requestId":"stale","projectId":project.id,"previousTitle":project.title,"title":"Stale"}),
                StatusCode::CONFLICT,
            ),
            (
                json!({"requestId":"rename-two","projectId":project.id,"previousTitle":"Saved name 中文","title":"Latest"}),
                StatusCode::OK,
            ),
            (rename, StatusCode::CONFLICT),
        ] {
            assert_eq!(
                project_post(app.clone(), "/v1/project/rename", body)
                    .await
                    .status(),
                expected
            );
        }
        let response = project_post(
            app,
            "/v1/project/ensure",
            json!({"requestId":"next-launch","title":"Other locale default"}),
        )
        .await;
        let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
        let current = serde_json::from_slice::<contracts::ProjectResponse>(&bytes)
            .unwrap()
            .project
            .unwrap();
        assert_eq!(current.id, project.id);
        assert_eq!(current.title, "Latest");
        assert_eq!(current.working_revision, project.working_revision);
        assert_eq!(current.approved_baseline, project.approved_baseline);
    }

    #[tokio::test]
    async fn validates_transport_trace_without_changing_auth_or_business_protocol() {
        let directory = tempfile::tempdir().unwrap();
        let app = router(
            SqliteProjectRepository::open(directory.path()).unwrap(),
            "test-token",
            "http://127.0.0.1:5173",
        );
        for (trace, expected) in [
            ("0123456789abcdef0123456789abcdef", true),
            ("CANARY-provider-url", false),
            ("ABCDEF0123456789ABCDEF0123456789", false),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/health")
                        .header("authorization", "Bearer test-token")
                        .header("x-scenesparrow-trace-id", trace)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().contains_key("x-scenesparrow-trace-id"),
                expected
            );
            let bytes = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains(trace));
            let health: contracts::Health = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(health.status, "ok");
        }
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/project")
                    .header("authorization", "Bearer diagnostics-only")
                    .header(
                        "x-scenesparrow-trace-id",
                        "0123456789abcdef0123456789abcdef",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn authenticates_validates_and_preserves_project_state() {
        let directory = tempfile::tempdir().unwrap();
        let app = router(
            SqliteProjectRepository::open(directory.path()).unwrap(),
            "test-token",
            "http://127.0.0.1:5173",
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/project")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/project")
                    .header("authorization", "Bearer test-token")
                    .header("origin", "https://untrusted.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        for (body, expected) in [
            (
                r#"{"requestId":"one","title":" "}"#,
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (r#"{"title":"Missing request"}"#, StatusCode::BAD_REQUEST),
            (
                r#"{"requestId":"one","title":"Unexpected","approvedBaseline":1}"#,
                StatusCode::BAD_REQUEST,
            ),
            (r#"{"requestId":"one","title":"幕雀"}"#, StatusCode::OK),
            (r#"{"requestId":"one","title":"幕雀"}"#, StatusCode::OK),
            (
                r#"{"requestId":"two","title":"Replacement"}"#,
                StatusCode::CONFLICT,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/project")
                        .header("authorization", "Bearer test-token")
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/project")
                    .header("authorization", "Bearer test-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(response.into_body(), 16 * 1024).await.unwrap();
        let result: contracts::ProjectResponse = serde_json::from_slice(&bytes).unwrap();
        let project = result.project.unwrap();
        assert_eq!(project.title, "幕雀");
        assert_eq!(project.working_revision, 0);
        assert_eq!(project.approved_baseline, None);
    }
}
