use crate::*;
use axum::{
    body::Body,
    extract::{Path, Query},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    routing::{delete, post},
};
use futures_util::{StreamExt, stream};
use scenesparrow_application::manuscript::DocumentRepository;
use scenesparrow_domain::{contracts::*, manuscript::ManuscriptError};
use std::{collections::VecDeque, convert::Infallible, time::Duration};
#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Page {
    after: Option<String>,
    offset: Option<usize>,
}
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/sources", get(sources))
        .route(
            "/v1/intakes",
            post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/v1/intakes/{id}", delete(cancel_intake).get(read_intake))
        .route(
            "/v1/document-jobs",
            post(action).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/v1/document-jobs/{id}", get(job))
        .route("/v1/source-extractions/{id}", get(extraction))
        .route("/v1/project/events", get(events))
}
async fn sources(State(state): State<AppState>, Query(page): Query<Page>) -> Response {
    database(state, None, move |r| r.read_sources(page.after.as_deref())).await
}
async fn job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| r.document_job(&id)).await
}
async fn extraction(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    database(state, None, move |r| {
        r.extraction_page(&id, page.offset.unwrap_or(0))
    })
    .await
}
async fn read_intake(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| r.read_intake(&id)).await
}
async fn cancel_intake(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    database(state, None, move |r| {
        r.cancel_intake(&id).map(|_| EmptyPayload {})
    })
    .await
}
async fn action(
    State(state): State<AppState>,
    body: Result<Json<DocumentAction>, JsonRejection>,
) -> Response {
    let action = match body {
        Ok(Json(a)) => a,
        Err(e) => {
            return api_error(
                e.status(),
                if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    "INPUT_TOO_LARGE"
                } else {
                    "INVALID_REQUEST"
                },
            );
        }
    };
    let service = state.service.clone();
    let result = tokio::task::spawn_blocking(move || service.repository().document_action(&action))
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)));
    if let Ok(job) = &result
        && job.status == DocumentJobStatus::Queued
    {
        let service = state.service.clone();
        let id = job.id.clone();
        let slots = state.document_slots.clone();
        tokio::spawn(async move {
            if let Ok(permit) = slots.acquire_owned().await {
                let _ = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let _ = service.repository().run_document(&id);
                })
                .await;
            }
        });
    }
    super::manuscript::result(result, None)
}
async fn upload(State(state): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let id = headers
        .get("x-intake-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let name = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| decode_name(v).ok())
        .unwrap_or_default();
    let mime = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let service = state.service.clone();
    let begin_id = id.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || {
        service.repository().begin_intake(&begin_id, &name, &mime)
    })
    .await
    .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)))
    {
        return super::manuscript::result::<Intake>(Err(error), None);
    }
    let mut stream = body.into_data_stream();
    let mut failure = None;
    loop {
        let next = match tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
            Ok(v) => v,
            Err(_) => {
                failure = Some(ManuscriptError("INVALID_REQUEST", None));
                break;
            }
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                failure = Some(ManuscriptError("INVALID_REQUEST", None));
                break;
            }
        };
        let service = state.service.clone();
        let append_id = id.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || {
            service.repository().append_intake(&append_id, &chunk)
        })
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)))
        {
            failure = Some(e);
            break;
        }
    }
    if let Some(error) = failure {
        let service = state.service.clone();
        let _ = tokio::task::spawn_blocking(move || service.repository().cancel_intake(&id)).await;
        return super::manuscript::result::<Intake>(Err(error), None);
    }
    database(state, None, move |r| r.complete_intake(&id)).await
}
fn decode_name(s: &str) -> Result<String, ()> {
    let mut bytes = vec![];
    let mut i = 0;
    let input = s.as_bytes();
    while i < input.len() {
        if input[i] == b'%' {
            if i + 2 >= input.len() {
                return Err(());
            }
            bytes.push(u8::from_str_radix(&s[i + 1..i + 3], 16).map_err(|_| ())?);
            i += 3;
        } else {
            bytes.push(input[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| ())
}
async fn events(State(state): State<AppState>, Query(page): Query<Page>) -> Response {
    let after = match page.after.as_deref().unwrap_or("0").parse::<i64>() {
        Ok(n) if n >= 0 => n,
        _ => return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST"),
    };
    let service = state.service.clone();
    let stream = stream::unfold(
        (service, after, VecDeque::<ProjectEvent>::new(), false),
        |(service, mut after, mut queue, mut done)| async move {
            if done {
                return None;
            }
            loop {
                if let Some(event) = queue.pop_front() {
                    after = event.sequence;
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((
                        Ok::<Event, Infallible>(
                            Event::default()
                                .event("project")
                                .id(after.to_string())
                                .data(data),
                        ),
                        (service, after, queue, done),
                    ));
                }
                let reader = service.clone();
                let result =
                    tokio::task::spawn_blocking(move || reader.repository().events(after)).await;
                match result {
                    Ok(Ok(page)) if page.resync_required => {
                        done = true;
                        return Some((
                            Ok(Event::default()
                                .event("resync_required")
                                .data(page.latest.to_string())),
                            (service, after, queue, done),
                        ));
                    }
                    Ok(Ok(page)) => {
                        queue = page.events.into();
                    }
                    _ => return None,
                }
                if queue.is_empty() {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response()
}
