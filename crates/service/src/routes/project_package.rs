//! Named packages and bounded binary upload; no browser paths or generic file API.
use super::project_transfer::store;
use crate::*;
use axum::{
    body::Bytes,
    extract::Path,
    http::{HeaderMap, header},
    routing::{post, put},
};
use scenesparrow_domain::contracts::*;
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/packages/base", get(base))
        .route("/v1/project/packages/exports", post(export))
        .route("/v1/project/work-items/{id}/package", post(work))
        .route("/v1/project/packages/operations/{id}", get(operation))
        .route(
            "/v1/project/packages/operations/{id}/control",
            post(control),
        )
        .route("/v1/project/packages/archives/{id}", get(archive))
        .route("/v1/project/package-intakes", post(intake))
        .route("/v1/project/package-intakes/{id}", get(intake_status))
        .route(
            "/v1/project/package-intakes/{id}/chunks",
            put(chunk).layer(DefaultBodyLimit::max(
                scenesparrow_infrastructure::project_transfer::package::MAX_CHUNK,
            )),
        )
        .route(
            "/v1/project/package-intakes/{id}/control",
            post(intake_control),
        )
        .route("/v1/project/packages/inspections", post(inspect))
        .route("/v1/project/packages/inspections/{id}", get(inspection))
        .route("/v1/project/packages/restore-targets", post(target))
        .route("/v1/project/packages/restores", post(restore))
        .route("/v1/project/packages/returns", post(returned))
}
async fn base(State(s): State<AppState>) -> Response {
    database(s, None, |r| r.read_package_base()).await
}
macro_rules! mutation {
    ($name:ident,$dto:ty,$method:ident) => {
        async fn $name(
            State(s): State<AppState>,
            body: Result<Json<$dto>, JsonRejection>,
        ) -> Response {
            let Ok(Json(request)) = body else {
                return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
            };
            let store = match store(&s) {
                Ok(s) => s,
                Err(e) => return manuscript::result::<()>(Err(e), Some(request.request_id)),
            };
            database(s, Some(request.request_id.clone()), move |r| {
                store.$method(r, &request)
            })
            .await
        }
    };
}
mutation!(export, ProjectPackageExportRequest, start_package_export);
mutation!(intake, PackageIntakeRequest, create_package_intake);
mutation!(inspect, PackageInspectionRequest, start_package_inspection);
mutation!(
    target,
    PackageRestoreTargetRequest,
    issue_package_restore_target
);
mutation!(restore, PackageRestoreRequest, start_package_restore);
mutation!(returned, PackageReturnRequest, start_package_return);
async fn work(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<WorkCopyPackageExportRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if request.work_item_id != id {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let store = match store(&s) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), Some(request.request_id)),
    };
    database(s, Some(request.request_id.clone()), move |r| {
        store.start_work_copy_package(r, &request)
    })
    .await
}
macro_rules! read {
    ($name:ident,$method:ident) => {
        async fn $name(State(s): State<AppState>, Path(id): Path<String>) -> Response {
            let store = match store(&s) {
                Ok(s) => s,
                Err(e) => return manuscript::result::<()>(Err(e), None),
            };
            database(s, None, move |r| store.$method(r, &id)).await
        }
    };
}
read!(operation, package_status);
read!(intake_status, package_intake);
read!(inspection, package_inspection);
async fn control(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<PackageControlRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if request.operation_id != id {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let store = match store(&s) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    database(s, Some(request.request_id.clone()), move |r| {
        store.control_package(r, &request)
    })
    .await
}
async fn intake_control(
    State(s): State<AppState>,
    Path(id): Path<String>,
    body: Result<Json<PackageIntakeControlRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if request.intake_id != id {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let store = match store(&s) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    database(s, Some(request.request_id.clone()), move |r| {
        store.control_package_intake(r, &request)
    })
    .await
}
async fn chunk(
    State(s): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let Ok(bytes) = body else {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "PACKAGE_SIZE_LIMIT");
    };
    let h = |name: &str| {
        headers
            .get(name)
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned)
    };
    let Some((owner, offset, length, hash)) = h("x-scenesparrow-owner-project-id")
        .zip(h("x-scenesparrow-chunk-offset"))
        .zip(h("x-scenesparrow-chunk-length"))
        .zip(h("x-scenesparrow-chunk-sha256"))
        .map(|(((o, a), b), c)| (o, a, b, c))
    else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    let (Ok(offset), Ok(length)) = (offset.parse::<i64>(), length.parse::<i64>()) else {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    };
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/octet-stream")
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok())
            != Some(bytes.len())
    {
        return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let request = PackageChunkRequest {
        owner_project_id: owner,
        intake_id: id,
        offset,
        length,
        hash,
    };
    let store = match store(&s) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    database(s, None, move |r| {
        store.write_package_chunk(r, &request, &bytes)
    })
    .await
}
async fn archive(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let store = match store(&s) {
        Ok(s) => s,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    let reader = match tokio::task::spawn_blocking(move || {
        store.read_package_archive(s.service.repository(), &id)
    })
    .await
    .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)))
    {
        Ok(r) => r,
        Err(e) => return manuscript::result::<()>(Err(e), None),
    };
    let view = reader.view().clone();
    let closing = reader.cancellation_flag();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    tokio::task::spawn_blocking(move || {
        struct Output(
            tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
            std::sync::Arc<std::sync::atomic::AtomicBool>,
        );
        impl std::io::Write for Output {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                let mut chunk = Ok(b.to_vec());
                loop {
                    if self.1.load(std::sync::atomic::Ordering::Acquire) {
                        return Err(std::io::Error::other("project closing"));
                    }
                    match self.0.try_send(chunk) {
                        Ok(()) => break,
                        Err(tokio::sync::mpsc::error::TrySendError::Full(value)) => {
                            chunk = value;
                            std::thread::sleep(std::time::Duration::from_millis(2));
                        }
                        Err(_) => return Err(std::io::Error::other("reader cancelled")),
                    }
                }
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut out = Output(tx, closing);
        if reader.stream(&mut out).is_err() {
            let _ = out
                .0
                .try_send(Err(std::io::Error::other("archive interrupted")));
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (chunk, rx))
    });
    let mut response = axum::body::Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    headers.insert(
        header::CONTENT_LENGTH,
        view.size.to_string().parse().unwrap(),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}\"", view.filename)
            .parse()
            .unwrap(),
    );
    headers.insert("x-scenesparrow-content-sha256", view.hash.parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
