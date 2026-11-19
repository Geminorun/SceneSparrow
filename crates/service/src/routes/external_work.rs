//! Named recorded work capabilities; no renderer-selected server path.
use crate::*;
use axum::{
    extract::{Path, Query},
    http::{HeaderMap, header},
    routing::post,
};
use scenesparrow_domain::contracts::*;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PageQuery {
    cursor: Option<String>,
}
pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/project/file-graph", get(graph))
        .route("/v1/project/file-graph/files", get(files))
        .route("/v1/project/file-graph/register", post(register))
        .route("/v1/project/work-items", get(items).post(create))
        .route("/v1/project/work-items/{id}", get(item))
        .route("/v1/project/work-items/{id}/inspect", post(inspect))
        .route("/v1/project/work-items/{id}/accept", post(accept))
        .route("/v1/project/work-items/{id}/discard", post(discard))
        .route("/v1/project/work-items/{id}/control", post(control))
        .route("/v1/project/work-items/{id}/reveal", get(reveal))
        .route(
            "/v1/project/work-items/{id}/candidates/{candidate}",
            get(candidate),
        )
        .route(
            "/v1/project/work-items/{id}/candidates/{candidate}/changes",
            get(changes),
        )
        .route(
            "/v1/project/work-items/{id}/candidates/{candidate}/members/{member}/{role}/bytes",
            get(candidate_bytes),
        )
        .route("/v1/project/work-operations/{request}", get(operation))
        .route("/v1/project/file-locks", get(locks).post(set_locks))
        .route("/v1/project/file-recoveries", get(recoveries))
        .route(
            "/v1/project/file-recoveries/{intent}",
            get(inspect_recovery),
        )
        .route("/v1/project/file-recoveries/{intent}/members", get(members))
        .route(
            "/v1/project/file-recoveries/{intent}/members/{member}/bytes",
            get(recovery_bytes),
        )
}
async fn graph(State(s): State<AppState>) -> Response {
    database(s, None, |r| r.file_graph_view()).await
}
async fn files(State(s): State<AppState>, Query(q): Query<PageQuery>) -> Response {
    database(s, None, move |r| r.graph_files_page(q.cursor.as_deref())).await
}
async fn items(State(s): State<AppState>, Query(q): Query<PageQuery>) -> Response {
    database(s, None, move |r| r.work_items_page(q.cursor.as_deref())).await
}
async fn item(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    database(s, None, move |r| r.work_item(&id)).await
}
async fn operation(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    database(s, None, move |r| r.work_operation(&id)).await
}
async fn candidate(
    State(s): State<AppState>,
    Path((item, id)): Path<(String, String)>,
) -> Response {
    database(s, None, move |r| r.work_candidate(&item, &id)).await
}
async fn changes(
    State(s): State<AppState>,
    Path((item, id)): Path<(String, String)>,
    Query(q): Query<PageQuery>,
) -> Response {
    database(s, None, move |r| {
        r.work_changes_page(&item, &id, q.cursor.as_deref())
    })
    .await
}
async fn locks(State(s): State<AppState>, Query(q): Query<PageQuery>) -> Response {
    database(s, None, move |r| {
        r.production_file_locks_page(q.cursor.as_deref())
    })
    .await
}
async fn recoveries(State(s): State<AppState>, Query(q): Query<PageQuery>) -> Response {
    database(s, None, move |r| {
        r.graph_recoveries_page(q.cursor.as_deref())
    })
    .await
}
async fn members(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PageQuery>,
) -> Response {
    database(s, None, move |r| {
        r.graph_recovery_members_page(&id, q.cursor.as_deref())
    })
    .await
}
macro_rules! mutation {
    ($name:ident,$dto:ty,$method:ident) => {
        async fn $name(
            State(s): State<AppState>,
            body: Result<Json<$dto>, JsonRejection>,
        ) -> Response {
            let Ok(Json(r)) = body else {
                return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
            };
            database(s, Some(r.request_id.clone()), move |p| p.$method(&r)).await
        }
    };
}
mutation!(create, WorkItemCreateRequest, create_work_item);
mutation!(register, GraphRegisterRequest, register_work_file_graph);
mutation!(
    set_locks,
    ProductionFileLockRequest,
    set_production_file_locks
);
macro_rules! item_mutation {
    ($name:ident,$dto:ty,$method:ident) => {
        async fn $name(
            State(s): State<AppState>,
            Path(id): Path<String>,
            body: Result<Json<$dto>, JsonRejection>,
        ) -> Response {
            let Ok(Json(r)) = body else {
                return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
            };
            if r.work_item_id != id {
                return api_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
            }
            database(s, Some(r.request_id.clone()), move |p| p.$method(&r)).await
        }
    };
}
item_mutation!(inspect, WorkItemInspectRequest, inspect_work_item);
item_mutation!(accept, WorkCandidateAcceptRequest, accept_work_candidate);
item_mutation!(discard, WorkItemDiscardRequest, discard_work_item);
item_mutation!(control, WorkItemControlRequest, control_work_item);
async fn reveal(State(s): State<AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !s.native_authorization.as_ref().is_some_and(|token| {
        headers
            .get("x-scenesparrow-native")
            .and_then(|h| h.to_str().ok())
            == Some(token)
    }) {
        return api_error(StatusCode::FORBIDDEN, "ORIGIN_DENIED");
    }
    database(s, None, move |r| {
        r.reveal_work_item_location(&id)
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}
async fn candidate_bytes(
    State(s): State<AppState>,
    Path((item, candidate, member, role)): Path<(String, String, String, String)>,
) -> Response {
    stream_member(s, move |r| {
        r.work_candidate_member(&item, &candidate, &member, &role)
    })
    .await
}
async fn recovery_bytes(
    State(s): State<AppState>,
    Path((intent, member)): Path<(String, String)>,
) -> Response {
    stream_member(s, move |r| r.graph_recovery_member_reader(&intent, &member)).await
}
async fn stream_member(
    s: AppState,
    open: impl FnOnce(
        &SqliteProjectRepository,
    ) -> Result<
        scenesparrow_infrastructure::open_source::graph::WorkMemberReader,
        ManuscriptError,
    > + Send
    + 'static,
) -> Response {
    let result = tokio::task::spawn_blocking(move || open(s.service.repository()))
        .await
        .unwrap_or(Err(ManuscriptError("STORAGE_UNAVAILABLE", None)));
    let reader = match result {
        Ok(reader) => reader,
        Err(e) => return manuscript::result::<EmptyPayload>(Err(e), None),
    };
    let hash = reader.hash().to_owned();
    let size = reader.size();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    tokio::task::spawn_blocking(move || {
        struct Output(tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>);
        impl std::io::Write for Output {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0
                    .blocking_send(Ok(bytes.to_vec()))
                    .map_err(|_| std::io::Error::other("reader cancelled"))?;
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut output = Output(tx);
        if reader.stream(&mut output).is_err() {
            let _ = output
                .0
                .blocking_send(Err(std::io::Error::other("member transfer interrupted")));
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (chunk, rx))
    });
    let mut response = axum::body::Body::from_stream(stream).into_response();
    response
        .headers_mut()
        .insert("x-scenesparrow-content-sha256", hash.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, size.to_string().parse().unwrap());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        "attachment; filename=\"creative-member.bin\""
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

async fn inspect_recovery(State(state): State<AppState>, Path(intent): Path<String>) -> Response {
    database(state, None, move |repository| {
        repository.inspect_graph_recovery(&intent)
    })
    .await
}
