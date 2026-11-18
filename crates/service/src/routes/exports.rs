use crate::*;
use axum::{
    extract::Path,
    http::{HeaderValue, header},
    routing::post,
};
use scenesparrow_domain::{contracts::*, manuscript::ManuscriptError};
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/quiesce", post(quiesce))
        .route("/v1/project/resume", post(resume))
        .route("/v1/project/backup", post(backup))
        .route("/v1/manuscript/identity", get(identity))
        .route("/v1/manuscript/copies", post(copy))
        .route("/v1/manuscript/copies/{id}", get(read_copy))
        .route("/v1/manuscript/exports", post(start).get(list))
        .route("/v1/manuscript/exports/{id}", get(read))
        .route("/v1/manuscript/exports/{id}/cancel", post(cancel))
        .route("/v1/manuscript/exports/{id}/retry", post(retry))
        .route("/v1/manuscript/exports/{id}/artifact", get(artifact))
        .route("/v1/manuscript/deliveries", post(intent))
        .route("/v1/manuscript/deliveries/{status}", post(finish))
}

async fn start(
    State(s): State<AppState>,
    body: Result<Json<ExportRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(s, None, move |p| p.start_export(&r)).await
}
async fn read(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    database(s, None, move |p| p.export_job(&id)).await
}
async fn cancel(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<ExportControl>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(s, None, move |p| p.cancel_export(&id, &r)).await
}
async fn retry(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<ExportRetry>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(s, None, move |p| p.retry_export(&id, &r)).await
}
async fn artifact(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let result = tokio::task::spawn_blocking(move || s.service.repository().export_bytes(&id))
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)));
    match result {
        Ok((j, bytes)) => {
            let mime = match j.format {
                ExportJobFormat::Txt => "text/plain; charset=utf-8",
                ExportJobFormat::Md => "text/markdown; charset=utf-8",
                ExportJobFormat::Docx => {
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                }
            };
            let mut response = bytes.into_response();
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            response.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&std::format!(
                    "attachment; filename=\"manuscript.{}\"; filename*=UTF-8''{}",
                    match j.format {
                        ExportJobFormat::Txt => "txt",
                        ExportJobFormat::Md => "md",
                        ExportJobFormat::Docx => "docx",
                    },
                    j.filename
                        .as_bytes()
                        .iter()
                        .map(|b| std::format!("%{b:02X}"))
                        .collect::<String>()
                ))
                .unwrap_or(HeaderValue::from_static("attachment")),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(e) => manuscript::result::<EmptyPayload>(Err(e), None),
    }
}
async fn intent(
    State(s): State<AppState>,
    body: Result<Json<DeliveryAction>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(s, None, move |p| p.delivery_receipt(&r, None)).await
}
async fn finish(
    State(s): State<AppState>,
    Path(status): Path<String>,
    body: Result<Json<DeliveryAction>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if !["saved", "unknown", "failed"].contains(&status.as_str()) {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    database(s, None, move |p| p.delivery_receipt(&r, Some(&status))).await
}

async fn quiesce(State(s): State<AppState>) -> Response {
    let r = tokio::task::spawn_blocking(move || s.service.repository().quiesce()).await;
    match r {
        Ok(Ok(())) => Json(EmptyPayload {}).into_response(),
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "SHUTDOWN_FAILED"),
    }
}
async fn resume(State(s): State<AppState>) -> Response {
    s.service.repository().resume();
    Json(EmptyPayload {}).into_response()
}
async fn backup(State(s): State<AppState>) -> Response {
    let r = tokio::task::spawn_blocking(move || s.service.repository().verified_backup()).await;
    match r {
        Ok(Ok(p)) => {
            Json(serde_json::json!({"id":p.file_name().unwrap_or_default().to_string_lossy()}))
                .into_response()
        }
        _ => api_error(StatusCode::SERVICE_UNAVAILABLE, "BACKUP_INVALID"),
    }
}

async fn copy(
    State(s): State<AppState>,
    body: Result<Json<CopyRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(r)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    database(s, None, move |p| p.prepare_copy(&r)).await
}
async fn read_copy(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    database(s, None, move |p| p.prepared_copy(&id)).await
}

async fn list(State(s): State<AppState>) -> Response {
    database(s, None, move |p| p.read_exports()).await
}

async fn identity(State(s): State<AppState>) -> Response {
    database(s, None, move |p| p.manuscript_identity()).await
}
