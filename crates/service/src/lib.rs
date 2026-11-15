pub mod contracts;
mod manuscript;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State, rejection::JsonRejection},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use scenesparrow_application::{Error, ProjectService};
use scenesparrow_infrastructure::SqliteProjectRepository;
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Clone)]
struct AppState {
    service: Arc<ProjectService<SqliteProjectRepository>>,
    authorization: String,
    allowed_origin: String,
    database_slots: Arc<Semaphore>,
}

pub fn router(repository: SqliteProjectRepository, token: &str, allowed_origin: &str) -> Router {
    let state = AppState {
        service: Arc::new(ProjectService::new(repository)),
        authorization: format!("Bearer {token}"),
        allowed_origin: allowed_origin.to_owned(),
        database_slots: Arc::new(Semaphore::new(4)),
    };
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/project", get(read_project).post(create_project))
        .merge(manuscript::routes())
        .fallback(|| async { api_error(StatusCode::NOT_FOUND, "NOT_FOUND") })
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state)
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

async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        != Some(state.authorization.as_str())
    {
        return api_error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
    }
    if let Some(origin) = request.headers().get("origin")
        && origin.to_str().ok() != Some(state.allowed_origin.as_str())
    {
        return api_error(StatusCode::FORBIDDEN, "ORIGIN_DENIED");
    }
    next.run(request).await
}

async fn health() -> Json<contracts::Health> {
    Json(contracts::Health {
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

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
