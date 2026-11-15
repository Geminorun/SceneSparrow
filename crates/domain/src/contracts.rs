// Generated from protocol.schema.json. Do not edit by hand.
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
pub enum MarkType {
    #[serde(rename = "bold")]
    Bold,
    #[serde(rename = "italic")]
    Italic,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "link")]
    Link,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mark {
    #[serde(rename = "type")]
    pub r#type: MarkType,
    #[serde(
        rename = "href",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub href: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextRun {
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "marks")]
    pub marks: Vec<Mark>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockAttrsListKind {
    #[serde(rename = "bullet")]
    Bullet,
    #[serde(rename = "ordered")]
    Ordered,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockAttrs {
    #[serde(
        rename = "level",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub level: Option<i64>,
    #[serde(
        rename = "listKind",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub list_kind: Option<BlockAttrsListKind>,
    #[serde(
        rename = "depth",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub depth: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewBlock {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: BlockKind,
    #[serde(rename = "attrs")]
    pub attrs: BlockAttrs,
    #[serde(rename = "runs")]
    pub runs: Vec<TextRun>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Block {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: BlockKind,
    #[serde(rename = "attrs")]
    pub attrs: BlockAttrs,
    #[serde(rename = "runs")]
    pub runs: Vec<TextRun>,
    #[serde(rename = "revision")]
    pub revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManuscriptStateWorkspaceStage {
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "draft")]
    Draft,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManuscriptState {
    #[serde(rename = "manuscriptId")]
    pub manuscript_id: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "workspaceStage")]
    pub workspace_stage: ManuscriptStateWorkspaceStage,
    #[serde(rename = "blocks")]
    pub blocks: Vec<Block>,
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlockRevision {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "revision")]
    pub revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EditGroupKind {
    #[serde(rename = "typing")]
    Typing,
    #[serde(rename = "discrete")]
    Discrete,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditGroup {
    #[serde(rename = "clientSessionId")]
    pub client_session_id: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
    #[serde(rename = "groupSequence")]
    pub group_sequence: i64,
    #[serde(rename = "kind")]
    pub kind: EditGroupKind,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum Primitive {
    #[serde(rename = "insertBlock")]
    InsertBlock {
        #[serde(rename = "block")]
        block: NewBlock,
        #[serde(rename = "after", deserialize_with = "required_nullable")]
        after: Option<String>,
    },
    #[serde(rename = "setBlockContent")]
    SetBlockContent {
        #[serde(rename = "id")]
        id: String,
        #[serde(rename = "runs")]
        runs: Vec<TextRun>,
    },
    #[serde(rename = "setBlockAttributes")]
    SetBlockAttributes {
        #[serde(rename = "id")]
        id: String,
        #[serde(rename = "kind")]
        kind: BlockKind,
        #[serde(rename = "attrs")]
        attrs: BlockAttrs,
    },
    #[serde(rename = "deleteBlock")]
    DeleteBlock {
        #[serde(rename = "id")]
        id: String,
    },
    #[serde(rename = "moveBlocks")]
    MoveBlocks {
        #[serde(rename = "ids")]
        ids: Vec<String>,
        #[serde(rename = "after", deserialize_with = "required_nullable")]
        after: Option<String>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyPayload {}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditPayload {
    #[serde(rename = "operations")]
    pub operations: Vec<Primitive>,
    #[serde(rename = "expectedBlockRevisions")]
    pub expected_block_revisions: Vec<BlockRevision>,
    #[serde(rename = "group")]
    pub group: EditGroup,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ManuscriptCommand {
    #[serde(rename = "StartManualDraft")]
    StartManualDraft {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: EmptyPayload,
    },
    #[serde(rename = "ApplyDocumentEdit")]
    ApplyDocumentEdit {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: EditPayload,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandReceipt {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "blockRevisions")]
    pub block_revisions: Vec<BlockRevision>,
    #[serde(rename = "historyRevision")]
    pub history_revision: i64,
    #[serde(rename = "cursor")]
    pub cursor: i64,
    #[serde(rename = "undoCount")]
    pub undo_count: i64,
    #[serde(rename = "redoCount")]
    pub redo_count: i64,
    #[serde(rename = "eventSequence")]
    pub event_sequence: i64,
    #[serde(rename = "normalized")]
    pub normalized: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockKind {
    #[serde(rename = "paragraph")]
    Paragraph,
    #[serde(rename = "heading")]
    Heading,
    #[serde(rename = "list_item")]
    Listitem,
}
