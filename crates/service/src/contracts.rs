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
}
