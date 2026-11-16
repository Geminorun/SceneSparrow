// Generated from protocol.schema.json. Do not edit by hand.
pub use scenesparrow_domain::contracts::*;
use serde::{Deserialize, Serialize};
fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
#[allow(dead_code)]
fn present_nonnull<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Project {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "approvedBaseline", deserialize_with = "required_nullable")]
    pub approved_baseline: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Health {
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateProject {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "title")]
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectResponse {
    #[serde(rename = "project", deserialize_with = "required_nullable")]
    pub project: Option<Project>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiError {
    #[serde(rename = "code")]
    pub code: String,
    #[serde(
        rename = "requestId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub request_id: Option<String>,
    #[serde(
        rename = "details",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub details: Option<HistoryErrorDetails>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputComponent {
    #[serde(rename = "gateway")]
    Gateway,
    #[serde(rename = "core")]
    Core,
    #[serde(rename = "worker")]
    Worker,
    #[serde(rename = "client")]
    Client,
    #[serde(rename = "supervisor")]
    Supervisor,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputLevel {
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "error")]
    Error,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputEventCode {
    #[serde(rename = "HTTP_COMPLETE")]
    HTTPCOMPLETE,
    #[serde(rename = "HTTP_ABORTED")]
    HTTPABORTED,
    #[serde(rename = "SSE_OPEN")]
    SSEOPEN,
    #[serde(rename = "AUTH_DENIED")]
    AUTHDENIED,
    #[serde(rename = "ORIGIN_DENIED")]
    ORIGINDENIED,
    #[serde(rename = "UPSTREAM_FAILED")]
    UPSTREAMFAILED,
    #[serde(rename = "CORE_START")]
    CORESTART,
    #[serde(rename = "CORE_READY")]
    COREREADY,
    #[serde(rename = "CORE_STOP")]
    CORESTOP,
    #[serde(rename = "CORE_FAILED")]
    COREFAILED,
    #[serde(rename = "CORE_REQUEST")]
    COREREQUEST,
    #[serde(rename = "WORKER_START")]
    WORKERSTART,
    #[serde(rename = "WORKER_RESULT")]
    WORKERRESULT,
    #[serde(rename = "CLIENT_FAILURE")]
    CLIENTFAILURE,
    #[serde(rename = "DIAGNOSTICS_DEGRADED")]
    DIAGNOSTICSDEGRADED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputStage {
    #[serde(rename = "startup")]
    Startup,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "request")]
    Request,
    #[serde(rename = "decode")]
    Decode,
    #[serde(rename = "bootstrap")]
    Bootstrap,
    #[serde(rename = "mounted")]
    Mounted,
    #[serde(rename = "dispatch")]
    Dispatch,
    #[serde(rename = "worker")]
    Worker,
    #[serde(rename = "collection")]
    Collection,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputRouteId {
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "asset")]
    Asset,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "manuscript")]
    Manuscript,
    #[serde(rename = "ai")]
    Ai,
    #[serde(rename = "events")]
    Events,
    #[serde(rename = "diagnostics")]
    Diagnostics,
    #[serde(rename = "health")]
    Health,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputMethod {
    #[serde(rename = "GET")]
    GET,
    #[serde(rename = "HEAD")]
    HEAD,
    #[serde(rename = "POST")]
    POST,
    #[serde(rename = "PUT")]
    PUT,
    #[serde(rename = "PATCH")]
    PATCH,
    #[serde(rename = "DELETE")]
    DELETE,
    #[serde(rename = "OPTIONS")]
    OPTIONS,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputResponseKind {
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "json")]
    Json,
    #[serde(rename = "event-stream")]
    Eventstream,
    #[serde(rename = "binary")]
    Binary,
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputCompletion {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "aborted")]
    Aborted,
    #[serde(rename = "truncated")]
    Truncated,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputCategory {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "video")]
    Video,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticInputCode {
    #[serde(rename = "UNKNOWN")]
    UNKNOWN,
    #[serde(rename = "BOOTSTRAP_FAILED")]
    BOOTSTRAPFAILED,
    #[serde(rename = "AUTH_REQUIRED")]
    AUTHREQUIRED,
    #[serde(rename = "HTTP_ERROR")]
    HTTPERROR,
    #[serde(rename = "NETWORK_TIMEOUT")]
    NETWORKTIMEOUT,
    #[serde(rename = "NETWORK_FAILED")]
    NETWORKFAILED,
    #[serde(rename = "RESPONSE_NOT_JSON")]
    RESPONSENOTJSON,
    #[serde(rename = "RESPONSE_EMPTY")]
    RESPONSEEMPTY,
    #[serde(rename = "RESPONSE_INVALID_JSON")]
    RESPONSEINVALIDJSON,
    #[serde(rename = "STORAGE_UNAVAILABLE")]
    STORAGEUNAVAILABLE,
    #[serde(rename = "SQLITE_BUSY")]
    SQLITEBUSY,
    #[serde(rename = "SQLITE_CORRUPT")]
    SQLITECORRUPT,
    #[serde(rename = "OS_DENIED")]
    OSDENIED,
    #[serde(rename = "OS_FULL")]
    OSFULL,
    #[serde(rename = "WORKER_INTERRUPTED")]
    WORKERINTERRUPTED,
    #[serde(rename = "REQUEST_TIMEOUT")]
    REQUESTTIMEOUT,
    #[serde(rename = "CANCELLED")]
    CANCELLED,
    #[serde(rename = "PROTOCOL_MISMATCH")]
    PROTOCOLMISMATCH,
    #[serde(rename = "WORKER_RESOURCE_LIMIT")]
    WORKERRESOURCELIMIT,
    #[serde(rename = "AUTH_REJECTED")]
    AUTHREJECTED,
    #[serde(rename = "CREDENTIAL_UNAVAILABLE")]
    CREDENTIALUNAVAILABLE,
    #[serde(rename = "MODEL_UNAVAILABLE")]
    MODELUNAVAILABLE,
    #[serde(rename = "CAPABILITY_UNSUPPORTED")]
    CAPABILITYUNSUPPORTED,
    #[serde(rename = "CONFIGURATION_STALE")]
    CONFIGURATIONSTALE,
    #[serde(rename = "SETTINGS_CONFLICT")]
    SETTINGSCONFLICT,
    #[serde(rename = "QUEUE_FULL")]
    QUEUEFULL,
    #[serde(rename = "RATE_LIMITED")]
    RATELIMITED,
    #[serde(rename = "CONTEXT_LIMIT")]
    CONTEXTLIMIT,
    #[serde(rename = "OUTPUT_TRUNCATED")]
    OUTPUTTRUNCATED,
    #[serde(rename = "INVALID_OUTPUT")]
    INVALIDOUTPUT,
    #[serde(rename = "PROVIDER_REFUSED")]
    PROVIDERREFUSED,
    #[serde(rename = "PROVIDER_REJECTED")]
    PROVIDERREJECTED,
    #[serde(rename = "INVALID_OUTPUT_SCHEMA")]
    INVALIDOUTPUTSCHEMA,
    #[serde(rename = "ARTIFACT_MISMATCH")]
    ARTIFACTMISMATCH,
    #[serde(rename = "ENDPOINT_REDIRECT")]
    ENDPOINTREDIRECT,
    #[serde(rename = "INPUT_TOO_LARGE")]
    INPUTTOOLARGE,
    #[serde(rename = "INVALID_INPUT")]
    INVALIDINPUT,
    #[serde(rename = "INVALID_URL")]
    INVALIDURL,
    #[serde(rename = "SUCCEEDED")]
    SUCCEEDED,
    #[serde(rename = "FAILED")]
    FAILED,
    #[serde(rename = "INTERRUPTED")]
    INTERRUPTED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticInput {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "component")]
    pub component: DiagnosticInputComponent,
    #[serde(rename = "level")]
    pub level: DiagnosticInputLevel,
    #[serde(rename = "eventCode")]
    pub event_code: DiagnosticInputEventCode,
    #[serde(
        rename = "stage",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub stage: Option<DiagnosticInputStage>,
    #[serde(
        rename = "routeId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub route_id: Option<DiagnosticInputRouteId>,
    #[serde(
        rename = "method",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub method: Option<DiagnosticInputMethod>,
    #[serde(
        rename = "status",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub status: Option<i64>,
    #[serde(
        rename = "durationMs",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub duration_ms: Option<i64>,
    #[serde(
        rename = "responseBytes",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub response_bytes: Option<i64>,
    #[serde(
        rename = "responseKind",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub response_kind: Option<DiagnosticInputResponseKind>,
    #[serde(
        rename = "completion",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub completion: Option<DiagnosticInputCompletion>,
    #[serde(
        rename = "traceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub trace_id: Option<String>,
    #[serde(
        rename = "parentTraceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub parent_trace_id: Option<String>,
    #[serde(
        rename = "cfRay",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub cf_ray: Option<String>,
    #[serde(
        rename = "category",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub category: Option<DiagnosticInputCategory>,
    #[serde(
        rename = "code",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub code: Option<DiagnosticInputCode>,
    #[serde(
        rename = "appBuild",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub app_build: Option<String>,
    #[serde(
        rename = "droppedEvents",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub dropped_events: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventComponent {
    #[serde(rename = "gateway")]
    Gateway,
    #[serde(rename = "core")]
    Core,
    #[serde(rename = "worker")]
    Worker,
    #[serde(rename = "client")]
    Client,
    #[serde(rename = "supervisor")]
    Supervisor,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventLevel {
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "error")]
    Error,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventEventCode {
    #[serde(rename = "HTTP_COMPLETE")]
    HTTPCOMPLETE,
    #[serde(rename = "HTTP_ABORTED")]
    HTTPABORTED,
    #[serde(rename = "SSE_OPEN")]
    SSEOPEN,
    #[serde(rename = "AUTH_DENIED")]
    AUTHDENIED,
    #[serde(rename = "ORIGIN_DENIED")]
    ORIGINDENIED,
    #[serde(rename = "UPSTREAM_FAILED")]
    UPSTREAMFAILED,
    #[serde(rename = "CORE_START")]
    CORESTART,
    #[serde(rename = "CORE_READY")]
    COREREADY,
    #[serde(rename = "CORE_STOP")]
    CORESTOP,
    #[serde(rename = "CORE_FAILED")]
    COREFAILED,
    #[serde(rename = "CORE_REQUEST")]
    COREREQUEST,
    #[serde(rename = "WORKER_START")]
    WORKERSTART,
    #[serde(rename = "WORKER_RESULT")]
    WORKERRESULT,
    #[serde(rename = "CLIENT_FAILURE")]
    CLIENTFAILURE,
    #[serde(rename = "DIAGNOSTICS_DEGRADED")]
    DIAGNOSTICSDEGRADED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventStage {
    #[serde(rename = "startup")]
    Startup,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "request")]
    Request,
    #[serde(rename = "decode")]
    Decode,
    #[serde(rename = "bootstrap")]
    Bootstrap,
    #[serde(rename = "mounted")]
    Mounted,
    #[serde(rename = "dispatch")]
    Dispatch,
    #[serde(rename = "worker")]
    Worker,
    #[serde(rename = "collection")]
    Collection,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventRouteId {
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "asset")]
    Asset,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "manuscript")]
    Manuscript,
    #[serde(rename = "ai")]
    Ai,
    #[serde(rename = "events")]
    Events,
    #[serde(rename = "diagnostics")]
    Diagnostics,
    #[serde(rename = "health")]
    Health,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventMethod {
    #[serde(rename = "GET")]
    GET,
    #[serde(rename = "HEAD")]
    HEAD,
    #[serde(rename = "POST")]
    POST,
    #[serde(rename = "PUT")]
    PUT,
    #[serde(rename = "PATCH")]
    PATCH,
    #[serde(rename = "DELETE")]
    DELETE,
    #[serde(rename = "OPTIONS")]
    OPTIONS,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventResponseKind {
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "json")]
    Json,
    #[serde(rename = "event-stream")]
    Eventstream,
    #[serde(rename = "binary")]
    Binary,
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventCompletion {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "aborted")]
    Aborted,
    #[serde(rename = "truncated")]
    Truncated,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventCategory {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "video")]
    Video,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticEventCode {
    #[serde(rename = "UNKNOWN")]
    UNKNOWN,
    #[serde(rename = "BOOTSTRAP_FAILED")]
    BOOTSTRAPFAILED,
    #[serde(rename = "AUTH_REQUIRED")]
    AUTHREQUIRED,
    #[serde(rename = "HTTP_ERROR")]
    HTTPERROR,
    #[serde(rename = "NETWORK_TIMEOUT")]
    NETWORKTIMEOUT,
    #[serde(rename = "NETWORK_FAILED")]
    NETWORKFAILED,
    #[serde(rename = "RESPONSE_NOT_JSON")]
    RESPONSENOTJSON,
    #[serde(rename = "RESPONSE_EMPTY")]
    RESPONSEEMPTY,
    #[serde(rename = "RESPONSE_INVALID_JSON")]
    RESPONSEINVALIDJSON,
    #[serde(rename = "STORAGE_UNAVAILABLE")]
    STORAGEUNAVAILABLE,
    #[serde(rename = "SQLITE_BUSY")]
    SQLITEBUSY,
    #[serde(rename = "SQLITE_CORRUPT")]
    SQLITECORRUPT,
    #[serde(rename = "OS_DENIED")]
    OSDENIED,
    #[serde(rename = "OS_FULL")]
    OSFULL,
    #[serde(rename = "WORKER_INTERRUPTED")]
    WORKERINTERRUPTED,
    #[serde(rename = "REQUEST_TIMEOUT")]
    REQUESTTIMEOUT,
    #[serde(rename = "CANCELLED")]
    CANCELLED,
    #[serde(rename = "PROTOCOL_MISMATCH")]
    PROTOCOLMISMATCH,
    #[serde(rename = "WORKER_RESOURCE_LIMIT")]
    WORKERRESOURCELIMIT,
    #[serde(rename = "AUTH_REJECTED")]
    AUTHREJECTED,
    #[serde(rename = "CREDENTIAL_UNAVAILABLE")]
    CREDENTIALUNAVAILABLE,
    #[serde(rename = "MODEL_UNAVAILABLE")]
    MODELUNAVAILABLE,
    #[serde(rename = "CAPABILITY_UNSUPPORTED")]
    CAPABILITYUNSUPPORTED,
    #[serde(rename = "CONFIGURATION_STALE")]
    CONFIGURATIONSTALE,
    #[serde(rename = "SETTINGS_CONFLICT")]
    SETTINGSCONFLICT,
    #[serde(rename = "QUEUE_FULL")]
    QUEUEFULL,
    #[serde(rename = "RATE_LIMITED")]
    RATELIMITED,
    #[serde(rename = "CONTEXT_LIMIT")]
    CONTEXTLIMIT,
    #[serde(rename = "OUTPUT_TRUNCATED")]
    OUTPUTTRUNCATED,
    #[serde(rename = "INVALID_OUTPUT")]
    INVALIDOUTPUT,
    #[serde(rename = "PROVIDER_REFUSED")]
    PROVIDERREFUSED,
    #[serde(rename = "PROVIDER_REJECTED")]
    PROVIDERREJECTED,
    #[serde(rename = "INVALID_OUTPUT_SCHEMA")]
    INVALIDOUTPUTSCHEMA,
    #[serde(rename = "ARTIFACT_MISMATCH")]
    ARTIFACTMISMATCH,
    #[serde(rename = "ENDPOINT_REDIRECT")]
    ENDPOINTREDIRECT,
    #[serde(rename = "INPUT_TOO_LARGE")]
    INPUTTOOLARGE,
    #[serde(rename = "INVALID_INPUT")]
    INVALIDINPUT,
    #[serde(rename = "INVALID_URL")]
    INVALIDURL,
    #[serde(rename = "SUCCEEDED")]
    SUCCEEDED,
    #[serde(rename = "FAILED")]
    FAILED,
    #[serde(rename = "INTERRUPTED")]
    INTERRUPTED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticEvent {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "component")]
    pub component: DiagnosticEventComponent,
    #[serde(rename = "level")]
    pub level: DiagnosticEventLevel,
    #[serde(rename = "eventCode")]
    pub event_code: DiagnosticEventEventCode,
    #[serde(
        rename = "stage",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub stage: Option<DiagnosticEventStage>,
    #[serde(
        rename = "routeId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub route_id: Option<DiagnosticEventRouteId>,
    #[serde(
        rename = "method",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub method: Option<DiagnosticEventMethod>,
    #[serde(
        rename = "status",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub status: Option<i64>,
    #[serde(
        rename = "durationMs",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub duration_ms: Option<i64>,
    #[serde(
        rename = "responseBytes",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub response_bytes: Option<i64>,
    #[serde(
        rename = "responseKind",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub response_kind: Option<DiagnosticEventResponseKind>,
    #[serde(
        rename = "completion",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub completion: Option<DiagnosticEventCompletion>,
    #[serde(
        rename = "traceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub trace_id: Option<String>,
    #[serde(
        rename = "parentTraceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub parent_trace_id: Option<String>,
    #[serde(
        rename = "cfRay",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub cf_ray: Option<String>,
    #[serde(
        rename = "category",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub category: Option<DiagnosticEventCategory>,
    #[serde(
        rename = "code",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub code: Option<DiagnosticEventCode>,
    #[serde(
        rename = "appBuild",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub app_build: Option<String>,
    #[serde(rename = "timestamp")]
    pub timestamp: String,
    #[serde(rename = "bootId")]
    pub boot_id: String,
    #[serde(rename = "sequence")]
    pub sequence: i64,
    #[serde(
        rename = "droppedEvents",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub dropped_events: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticGrantMetadataScope {
    #[serde(rename = "diagnostics:read")]
    Diagnosticsread,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticGrantMetadata {
    #[serde(rename = "grantId")]
    pub grant_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "scope")]
    pub scope: DiagnosticGrantMetadataScope,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticGrantScope {
    #[serde(rename = "diagnostics:read")]
    Diagnosticsread,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticGrant {
    #[serde(rename = "grantId")]
    pub grant_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "scope")]
    pub scope: DiagnosticGrantScope,
    #[serde(rename = "token")]
    pub token: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticGrantRequest {
    #[serde(
        rename = "ttlSeconds",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub ttl_seconds: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticRevocation {
    #[serde(rename = "revoked")]
    pub revoked: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticClientAccepted {
    #[serde(rename = "accepted")]
    pub accepted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventComponent {
    #[serde(rename = "client")]
    Client,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventLevel {
    #[serde(rename = "warn")]
    Warn,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventEventCode {
    #[serde(rename = "CLIENT_FAILURE")]
    CLIENTFAILURE,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventStage {
    #[serde(rename = "request")]
    Request,
    #[serde(rename = "decode")]
    Decode,
    #[serde(rename = "bootstrap")]
    Bootstrap,
    #[serde(rename = "mounted")]
    Mounted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventRouteId {
    #[serde(rename = "document")]
    Document,
    #[serde(rename = "asset")]
    Asset,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "manuscript")]
    Manuscript,
    #[serde(rename = "ai")]
    Ai,
    #[serde(rename = "events")]
    Events,
    #[serde(rename = "diagnostics")]
    Diagnostics,
    #[serde(rename = "health")]
    Health,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticClientEventCode {
    #[serde(rename = "AUTH_REQUIRED")]
    AUTHREQUIRED,
    #[serde(rename = "HTTP_ERROR")]
    HTTPERROR,
    #[serde(rename = "NETWORK_TIMEOUT")]
    NETWORKTIMEOUT,
    #[serde(rename = "NETWORK_FAILED")]
    NETWORKFAILED,
    #[serde(rename = "RESPONSE_NOT_JSON")]
    RESPONSENOTJSON,
    #[serde(rename = "RESPONSE_EMPTY")]
    RESPONSEEMPTY,
    #[serde(rename = "RESPONSE_INVALID_JSON")]
    RESPONSEINVALIDJSON,
    #[serde(rename = "BOOTSTRAP_FAILED")]
    BOOTSTRAPFAILED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticClientEvent {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "component")]
    pub component: DiagnosticClientEventComponent,
    #[serde(rename = "level")]
    pub level: DiagnosticClientEventLevel,
    #[serde(rename = "eventCode")]
    pub event_code: DiagnosticClientEventEventCode,
    #[serde(rename = "stage")]
    pub stage: DiagnosticClientEventStage,
    #[serde(rename = "routeId")]
    pub route_id: DiagnosticClientEventRouteId,
    #[serde(rename = "code")]
    pub code: DiagnosticClientEventCode,
    #[serde(
        rename = "status",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub status: Option<i64>,
    #[serde(
        rename = "traceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub trace_id: Option<String>,
    #[serde(
        rename = "appBuild",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub app_build: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticWindow {
    #[serde(rename = "since")]
    pub since: String,
    #[serde(rename = "until")]
    pub until: String,
    #[serde(rename = "retainedSince", deserialize_with = "required_nullable")]
    pub retained_since: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticLogPage {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "events")]
    pub events: Vec<DiagnosticEvent>,
    #[serde(rename = "window")]
    pub window: DiagnosticWindow,
    #[serde(rename = "nextCursor", deserialize_with = "required_nullable")]
    pub next_cursor: Option<String>,
    #[serde(rename = "gap")]
    pub gap: bool,
    #[serde(rename = "truncated")]
    pub truncated: bool,
    #[serde(rename = "droppedEvents")]
    pub dropped_events: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticStatusCollector {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "DIAGNOSTICS_DEGRADED")]
    DIAGNOSTICSDEGRADED,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticStatusRetained {
    #[serde(rename = "since", deserialize_with = "required_nullable")]
    pub since: Option<String>,
    #[serde(rename = "until", deserialize_with = "required_nullable")]
    pub until: Option<String>,
    #[serde(rename = "bytes")]
    pub bytes: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticStatus {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "appVersion")]
    pub app_version: String,
    #[serde(rename = "buildSha")]
    pub build_sha: String,
    #[serde(rename = "bootId")]
    pub boot_id: String,
    #[serde(rename = "bootTime")]
    pub boot_time: String,
    #[serde(rename = "gatewayAvailable")]
    pub gateway_available: bool,
    #[serde(rename = "coreAvailable")]
    pub core_available: bool,
    #[serde(rename = "collector")]
    pub collector: DiagnosticStatusCollector,
    #[serde(rename = "retained")]
    pub retained: DiagnosticStatusRetained,
    #[serde(rename = "droppedEvents")]
    pub dropped_events: i64,
    #[serde(rename = "errors")]
    pub errors: i64,
    #[serde(rename = "queueEvents")]
    pub queue_events: i64,
    #[serde(rename = "queueBytes")]
    pub queue_bytes: i64,
    #[serde(
        rename = "activeGrant",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub active_grant: Option<Option<DiagnosticGrantMetadata>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBundleManifestRetention {
    #[serde(rename = "bytes")]
    pub bytes: i64,
    #[serde(rename = "ageSeconds")]
    pub age_seconds: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBundleManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "retention")]
    pub retention: DiagnosticBundleManifestRetention,
    #[serde(rename = "eventLimit")]
    pub event_limit: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticBundle {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "events")]
    pub events: Vec<DiagnosticEvent>,
    #[serde(rename = "window")]
    pub window: DiagnosticWindow,
    #[serde(rename = "nextCursor", deserialize_with = "required_nullable")]
    pub next_cursor: Option<String>,
    #[serde(rename = "gap")]
    pub gap: bool,
    #[serde(rename = "truncated")]
    pub truncated: bool,
    #[serde(rename = "droppedEvents")]
    pub dropped_events: i64,
    #[serde(rename = "status")]
    pub status: DiagnosticStatus,
    #[serde(rename = "manifest")]
    pub manifest: DiagnosticBundleManifest,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticApiErrorCode {
    #[serde(rename = "INVALID_DIAGNOSTICS_QUERY")]
    INVALIDDIAGNOSTICSQUERY,
    #[serde(rename = "INVALID_DIAGNOSTICS_EVENT")]
    INVALIDDIAGNOSTICSEVENT,
    #[serde(rename = "UNAUTHORIZED")]
    UNAUTHORIZED,
    #[serde(rename = "DIAGNOSTICS_GRANT_EXPIRED")]
    DIAGNOSTICSGRANTEXPIRED,
    #[serde(rename = "DIAGNOSTICS_SCOPE_DENIED")]
    DIAGNOSTICSSCOPEDENIED,
    #[serde(rename = "ORIGIN_DENIED")]
    ORIGINDENIED,
    #[serde(rename = "NOT_FOUND")]
    NOTFOUND,
    #[serde(rename = "METHOD_NOT_ALLOWED")]
    METHODNOTALLOWED,
    #[serde(rename = "CURSOR_EXPIRED")]
    CURSOREXPIRED,
    #[serde(rename = "INPUT_TOO_LARGE")]
    INPUTTOOLARGE,
    #[serde(rename = "DIAGNOSTICS_RATE_LIMITED")]
    DIAGNOSTICSRATELIMITED,
    #[serde(rename = "DIAGNOSTICS_UNAVAILABLE")]
    DIAGNOSTICSUNAVAILABLE,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticApiError {
    #[serde(rename = "code")]
    pub code: DiagnosticApiErrorCode,
    #[serde(rename = "traceId")]
    pub trace_id: String,
}
