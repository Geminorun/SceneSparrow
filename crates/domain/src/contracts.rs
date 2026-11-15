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
    #[serde(rename = "UndoProject")]
    UndoProject {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "expectedHistoryRevision")]
        expected_history_revision: i64,
        #[serde(rename = "expectedCursor")]
        expected_cursor: i64,
        #[serde(rename = "payload")]
        payload: EmptyPayload,
    },
    #[serde(rename = "RedoProject")]
    RedoProject {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "expectedHistoryRevision")]
        expected_history_revision: i64,
        #[serde(rename = "expectedCursor")]
        expected_cursor: i64,
        #[serde(rename = "payload")]
        payload: EmptyPayload,
    },
    #[serde(rename = "CloseEditGroup")]
    CloseEditGroup {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "expectedHistoryRevision")]
        expected_history_revision: i64,
        #[serde(rename = "expectedCursor")]
        expected_cursor: i64,
        #[serde(rename = "payload")]
        payload: CloseGroupPayload,
    },
    #[serde(rename = "AddSourceLink")]
    AddSourceLink {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: AddSourceLinkPayload,
    },
    #[serde(rename = "AddSourceFile")]
    AddSourceFile {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: AddSourceFilePayload,
    },
    #[serde(rename = "RemoveSource")]
    RemoveSource {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: RemoveSourcePayload,
    },
    #[serde(rename = "CommitManuscriptImport")]
    CommitManuscriptImport {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: CommitManuscriptImportPayload,
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
    #[serde(
        rename = "undoLabel",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub undo_label: Option<String>,
    #[serde(
        rename = "redoLabel",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub redo_label: Option<String>,
    #[serde(
        rename = "sourceRevisions",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub source_revisions: Option<Vec<BlockRevision>>,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryState {
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "historyRevision")]
    pub history_revision: i64,
    #[serde(rename = "cursor")]
    pub cursor: i64,
    #[serde(rename = "undoCount")]
    pub undo_count: i64,
    #[serde(rename = "redoCount")]
    pub redo_count: i64,
    #[serde(rename = "undoLabel", deserialize_with = "required_nullable")]
    pub undo_label: Option<String>,
    #[serde(rename = "redoLabel", deserialize_with = "required_nullable")]
    pub redo_label: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseGroupPayload {
    #[serde(rename = "clientSessionId")]
    pub client_session_id: String,
    #[serde(rename = "groupId")]
    pub group_id: String,
    #[serde(rename = "groupSequence")]
    pub group_sequence: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryErrorDetails {
    #[serde(rename = "reason")]
    pub reason: String,
    #[serde(rename = "affectedIds")]
    pub affected_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceKind {
    #[serde(rename = "link")]
    Link,
    #[serde(rename = "file")]
    File,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceEvidence {
    #[serde(rename = "link_only")]
    Linkonly,
    #[serde(rename = "file_bytes")]
    Filebytes,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "kind")]
    pub kind: SourceKind,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(
        rename = "url",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub url: Option<String>,
    #[serde(
        rename = "objectHash",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub object_hash: Option<String>,
    #[serde(
        rename = "mimeType",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub mime_type: Option<String>,
    #[serde(
        rename = "size",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub size: Option<i64>,
    #[serde(rename = "evidence")]
    pub evidence: SourceEvidence,
    #[serde(
        rename = "intakeId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub intake_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceSummaryStatus {
    #[serde(rename = "link_only")]
    Linkonly,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceSummary {
    #[serde(rename = "source")]
    pub source: Source,
    #[serde(
        rename = "jobId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub job_id: Option<String>,
    #[serde(rename = "status")]
    pub status: SourceSummaryStatus,
    #[serde(
        rename = "error",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub error: Option<String>,
    #[serde(rename = "warnings")]
    pub warnings: Vec<String>,
    #[serde(rename = "hasImages")]
    pub has_images: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePage {
    #[serde(rename = "items")]
    pub items: Vec<SourceSummary>,
    #[serde(rename = "next", deserialize_with = "required_nullable")]
    pub next: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intake {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "hash")]
    pub hash: String,
    #[serde(rename = "size")]
    pub size: i64,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum DocumentAction {
    #[serde(rename = "prepareFile")]
    PrepareFile {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "intakeId")]
        intake_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
    },
    #[serde(rename = "preparePaste")]
    PreparePaste {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "text")]
        text: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
    },
    #[serde(rename = "extractSource")]
    ExtractSource {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    #[serde(rename = "cancel")]
    Cancel {
        #[serde(rename = "jobId")]
        job_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentResult {
    #[serde(rename = "parser")]
    pub parser: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "blocks")]
    pub blocks: Vec<NewBlock>,
    #[serde(rename = "warnings")]
    pub warnings: Vec<String>,
    #[serde(rename = "hasImages")]
    pub has_images: bool,
    #[serde(rename = "references")]
    pub references: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DocumentJobStatus {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "interrupted")]
    Interrupted,
    #[serde(rename = "cancelled")]
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DocumentJobPurpose {
    #[serde(rename = "import")]
    Import,
    #[serde(rename = "source")]
    Source,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentJob {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "status")]
    pub status: DocumentJobStatus,
    #[serde(rename = "purpose")]
    pub purpose: DocumentJobPurpose,
    #[serde(rename = "inputHash")]
    pub input_hash: String,
    #[serde(rename = "baseRevision")]
    pub base_revision: i64,
    #[serde(
        rename = "sourceId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub source_id: Option<String>,
    #[serde(
        rename = "result",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub result: Option<DocumentResult>,
    #[serde(
        rename = "error",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub error: Option<String>,
    #[serde(
        rename = "candidateHash",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub candidate_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExtractionPage {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "offset")]
    pub offset: i64,
    #[serde(rename = "next", deserialize_with = "required_nullable")]
    pub next: Option<i64>,
    #[serde(rename = "warnings")]
    pub warnings: Vec<String>,
    #[serde(rename = "references")]
    pub references: Vec<String>,
    #[serde(rename = "hasImages")]
    pub has_images: bool,
    #[serde(rename = "parser")]
    pub parser: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProjectEventType {
    #[serde(rename = "manuscript.changed")]
    Manuscriptchanged,
    #[serde(rename = "history.changed")]
    Historychanged,
    #[serde(rename = "sources.changed")]
    Sourceschanged,
    #[serde(rename = "documentJob.changed")]
    DocumentJobchanged,
    #[serde(rename = "resync_required")]
    Resyncrequired,
    #[serde(rename = "aiRun.changed")]
    AiRunchanged,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectEvent {
    #[serde(rename = "sequence")]
    pub sequence: i64,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "type")]
    pub r#type: ProjectEventType,
    #[serde(
        rename = "requestId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub request_id: Option<String>,
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "affectedIds")]
    pub affected_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventPage {
    #[serde(rename = "events")]
    pub events: Vec<ProjectEvent>,
    #[serde(rename = "latest")]
    pub latest: i64,
    #[serde(rename = "resyncRequired")]
    pub resync_required: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddSourceLinkPayload {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "url")]
    pub url: String,
    #[serde(rename = "title")]
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddSourceFilePayload {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "intakeId")]
    pub intake_id: String,
    #[serde(rename = "hash")]
    pub hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoveSourcePayload {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "expectedSourceRevision")]
    pub expected_source_revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommitManuscriptImportPayloadMode {
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "append")]
    Append,
    #[serde(rename = "replace")]
    Replace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitManuscriptImportPayload {
    #[serde(rename = "preparedId")]
    pub prepared_id: String,
    #[serde(rename = "candidateHash")]
    pub candidate_hash: String,
    #[serde(rename = "mode")]
    pub mode: CommitManuscriptImportPayloadMode,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentWorkerInput {
    #[serde(rename = "version")]
    pub version: i64,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "path")]
    pub path: String,
    #[serde(rename = "name")]
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentWorkerOutput {
    #[serde(rename = "version")]
    pub version: i64,
    #[serde(
        rename = "attempt",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub attempt: Option<i64>,
    #[serde(
        rename = "result",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub result: Option<DocumentResult>,
    #[serde(
        rename = "error",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiCategory {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "audio")]
    Audio,
    #[serde(rename = "video")]
    Video,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiCapability {
    #[serde(rename = "text.generate")]
    Textgenerate,
    #[serde(rename = "audio.synthesize")]
    Audiosynthesize,
    #[serde(rename = "video.generate")]
    Videogenerate,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiEvidenceState {
    #[serde(rename = "supported")]
    Supported,
    #[serde(rename = "unsupported")]
    Unsupported,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiEvidenceSource {
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "provider")]
    Provider,
    #[serde(rename = "test")]
    Test,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiEvidence {
    #[serde(rename = "state")]
    pub state: AiEvidenceState,
    #[serde(rename = "source")]
    pub source: AiEvidenceSource,
    #[serde(rename = "scope")]
    pub scope: String,
    #[serde(rename = "observedAt", deserialize_with = "required_nullable")]
    pub observed_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiCapabilities {
    #[serde(rename = "images")]
    pub images: AiEvidence,
    #[serde(rename = "streaming")]
    pub streaming: AiEvidence,
    #[serde(rename = "nativeJson")]
    pub native_json: AiEvidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiProviderAdapter {
    #[serde(rename = "openai_compatible")]
    Openaicompatible,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiProviderAuthMode {
    #[serde(rename = "bearer")]
    Bearer,
    #[serde(rename = "none")]
    None,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiProvider {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "label")]
    pub label: String,
    #[serde(rename = "adapter")]
    pub adapter: AiProviderAdapter,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "authMode")]
    pub auth_mode: AiProviderAuthMode,
    #[serde(rename = "credentialRevision", deserialize_with = "required_nullable")]
    pub credential_revision: Option<String>,
    #[serde(rename = "revision")]
    pub revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiModelTokenField {
    #[serde(rename = "max_tokens")]
    Maxtokens,
    #[serde(rename = "max_completion_tokens")]
    Maxcompletiontokens,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiModel {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "label")]
    pub label: String,
    #[serde(rename = "capabilities")]
    pub capabilities: AiCapabilities,
    #[serde(rename = "contextTokens", deserialize_with = "required_nullable")]
    pub context_tokens: Option<i64>,
    #[serde(rename = "outputTokens", deserialize_with = "required_nullable")]
    pub output_tokens: Option<i64>,
    #[serde(rename = "tokenField")]
    pub token_field: AiModelTokenField,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiParameters {
    #[serde(rename = "temperatureMilli", deserialize_with = "required_nullable")]
    pub temperature_milli: Option<i64>,
    #[serde(rename = "maxOutputTokens")]
    pub max_output_tokens: i64,
    #[serde(rename = "requestStreaming")]
    pub request_streaming: bool,
    #[serde(rename = "requestNativeJson")]
    pub request_native_json: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiBinding {
    #[serde(rename = "category")]
    pub category: AiCategory,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "parameters")]
    pub parameters: AiParameters,
    #[serde(rename = "revision")]
    pub revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiPolicy {
    #[serde(rename = "overallMs")]
    pub overall_ms: i64,
    #[serde(rename = "idleMs")]
    pub idle_ms: i64,
    #[serde(rename = "maxOutputBytes")]
    pub max_output_bytes: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSettings {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "providers")]
    pub providers: Vec<AiProvider>,
    #[serde(rename = "models")]
    pub models: Vec<AiModel>,
    #[serde(rename = "bindings")]
    pub bindings: Vec<AiBinding>,
    #[serde(rename = "retiredProfileIds")]
    pub retired_profile_ids: Vec<String>,
    #[serde(rename = "policy")]
    pub policy: AiPolicy,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiSettingsViewCredentialBackend {
    #[serde(rename = "native")]
    Native,
    #[serde(rename = "session_only")]
    Sessiononly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSettingsView {
    #[serde(rename = "settings")]
    pub settings: AiSettings,
    #[serde(rename = "credentialBackend")]
    pub credential_backend: AiSettingsViewCredentialBackend,
    #[serde(rename = "presentCredentialRevisions")]
    pub present_credential_revisions: Vec<String>,
    #[serde(rename = "sessionId")]
    pub session_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSettingsUpdate {
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    #[serde(rename = "settings")]
    pub settings: AiSettings,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiCredentialUpdate {
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "secret")]
    pub secret: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiResolvedConfig {
    #[serde(rename = "category")]
    pub category: AiCategory,
    #[serde(rename = "capability")]
    pub capability: AiCapability,
    #[serde(rename = "provider")]
    pub provider: AiProvider,
    #[serde(rename = "model")]
    pub model: AiModel,
    #[serde(rename = "parameters")]
    pub parameters: AiParameters,
    #[serde(rename = "policy")]
    pub policy: AiPolicy,
    #[serde(rename = "adapterVersion")]
    pub adapter_version: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "stream")]
    pub stream: bool,
    #[serde(rename = "nativeJson")]
    pub native_json: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiReadiness {
    #[serde(rename = "configuration")]
    pub configuration: AiResolvedConfig,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiModelAction {
    #[serde(rename = "providerId")]
    pub provider_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiTestAction {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "target")]
    pub target: AiTestTarget,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiDiscovery {
    #[serde(rename = "models")]
    pub models: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiTestReceiptStatus {
    #[serde(rename = "succeeded")]
    Succeeded,
    #[serde(rename = "failed")]
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiTestReceiptScope {
    #[serde(rename = "text_only")]
    Textonly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiTestReceipt {
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "status")]
    pub status: AiTestReceiptStatus,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "observedAt")]
    pub observed_at: String,
    #[serde(rename = "scope")]
    pub scope: AiTestReceiptScope,
    #[serde(rename = "target")]
    pub target: AiTestTarget,
    #[serde(rename = "providerRoot", deserialize_with = "required_nullable")]
    pub provider_root: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiArtifactMime {
    #[serde(rename = "text/plain")]
    Textplain,
    #[serde(rename = "application/json")]
    Applicationjson,
    #[serde(rename = "image/png")]
    Imagepng,
    #[serde(rename = "image/jpeg")]
    Imagejpeg,
    #[serde(rename = "image/webp")]
    Imagewebp,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiArtifact {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "hash")]
    pub hash: String,
    #[serde(rename = "mime")]
    pub mime: AiArtifactMime,
    #[serde(rename = "size")]
    pub size: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum AiPart {
    #[serde(rename = "text")]
    Text {
        #[serde(rename = "text")]
        text: String,
    },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "artifactId")]
        artifact_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiMessageRole {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "assistant")]
    Assistant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiMessage {
    #[serde(rename = "role")]
    pub role: AiMessageRole,
    #[serde(rename = "content")]
    pub content: Vec<AiPart>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiOutputSpecMime {
    #[serde(rename = "text/plain")]
    Textplain,
    #[serde(rename = "application/json")]
    Applicationjson,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiOutputSpec {
    #[serde(rename = "mime")]
    pub mime: AiOutputSpecMime,
    #[serde(rename = "schemaId")]
    pub schema_id: String,
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "schemaArtifactId", deserialize_with = "required_nullable")]
    pub schema_artifact_id: Option<String>,
    #[serde(rename = "maxBytes")]
    pub max_bytes: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiInputImageDecision {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "attempt")]
    Attempt,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiInput {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: i64,
    #[serde(rename = "messages")]
    pub messages: Vec<AiMessage>,
    #[serde(rename = "inputArtifacts")]
    pub input_artifacts: Vec<AiArtifact>,
    #[serde(rename = "outputSpec")]
    pub output_spec: AiOutputSpec,
    #[serde(rename = "imageDecision")]
    pub image_decision: AiInputImageDecision,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiStart {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "inputHash")]
    pub input_hash: String,
    #[serde(rename = "consumer")]
    pub consumer: String,
    #[serde(rename = "bindingId")]
    pub binding_id: String,
    #[serde(rename = "retryOfRunId", deserialize_with = "required_nullable")]
    pub retry_of_run_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiRunStatus {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "cancelling")]
    Cancelling,
    #[serde(rename = "succeeded")]
    Succeeded,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "interrupted")]
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiRun {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "inputHash")]
    pub input_hash: String,
    #[serde(rename = "configuration")]
    pub configuration: AiResolvedConfig,
    #[serde(rename = "status")]
    pub status: AiRunStatus,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "result", deserialize_with = "required_nullable")]
    pub result: Option<AiArtifact>,
    #[serde(rename = "retryOfRunId", deserialize_with = "required_nullable")]
    pub retry_of_run_id: Option<String>,
    #[serde(rename = "consumer")]
    pub consumer: String,
    #[serde(rename = "bindingId")]
    pub binding_id: String,
    #[serde(rename = "usage", deserialize_with = "required_nullable")]
    pub usage: Option<AiUsage>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiUsage {
    #[serde(rename = "inputTokens", deserialize_with = "required_nullable")]
    pub input_tokens: Option<i64>,
    #[serde(rename = "outputTokens", deserialize_with = "required_nullable")]
    pub output_tokens: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiCompletionFinishReason {
    #[serde(rename = "stop")]
    Stop,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiCompletion {
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "fence")]
    pub fence: String,
    #[serde(rename = "inputHash")]
    pub input_hash: String,
    #[serde(rename = "outputHash")]
    pub output_hash: String,
    #[serde(rename = "finishReason")]
    pub finish_reason: AiCompletionFinishReason,
    #[serde(rename = "usage", deserialize_with = "required_nullable")]
    pub usage: Option<AiUsage>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiWorkerControlOperation {
    #[serde(rename = "generate")]
    Generate,
    #[serde(rename = "discover")]
    Discover,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum AiWorkerControl {
    #[serde(rename = "start")]
    Start {
        #[serde(rename = "protocolVersion")]
        protocol_version: i64,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attempt")]
        attempt: i64,
        #[serde(rename = "fence")]
        fence: String,
        #[serde(rename = "inputHash")]
        input_hash: String,
        #[serde(rename = "configuration")]
        configuration: Box<AiResolvedConfig>,
        #[serde(rename = "operation")]
        operation: AiWorkerControlOperation,
    },
    #[serde(rename = "artifact_chunk")]
    ArtifactChunk {
        #[serde(rename = "id")]
        id: String,
        #[serde(rename = "data")]
        data: String,
    },
    #[serde(rename = "artifact_end")]
    ArtifactEnd {
        #[serde(rename = "artifact")]
        artifact: AiArtifact,
    },
    #[serde(rename = "credential_lease")]
    CredentialLease {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "fence")]
        fence: String,
        #[serde(rename = "secret", deserialize_with = "required_nullable")]
        secret: Option<String>,
    },
    #[serde(rename = "dispatch_permit")]
    DispatchPermit {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "fence")]
        fence: String,
    },
    #[serde(rename = "abort")]
    Abort {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "fence")]
        fence: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiWorkerEventPhase {
    #[serde(rename = "validated")]
    Validated,
    #[serde(rename = "dispatch_ready")]
    Dispatchready,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum AiWorkerEvent {
    #[serde(rename = "started")]
    Started {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "attempt")]
        attempt: i64,
        #[serde(rename = "fence")]
        fence: String,
    },
    #[serde(rename = "progress")]
    Progress {
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "phase")]
        phase: AiWorkerEventPhase,
    },
    #[serde(rename = "output_delta")]
    OutputDelta {
        #[serde(rename = "text")]
        text: String,
    },
    #[serde(rename = "output_chunk")]
    OutputChunk {
        #[serde(rename = "data")]
        data: String,
    },
    #[serde(rename = "usage")]
    Usage {
        #[serde(rename = "usage")]
        usage: AiUsage,
    },
    #[serde(rename = "completed")]
    Completed {
        #[serde(rename = "receipt")]
        receipt: AiCompletion,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(rename = "code")]
        code: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSearchEntry {
    #[serde(rename = "url")]
    pub url: String,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "snippet")]
    pub snippet: String,
    #[serde(rename = "provider")]
    pub provider: String,
    #[serde(rename = "retrievedAt")]
    pub retrieved_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiSearchResult {
    #[serde(rename = "available")]
    pub available: bool,
    #[serde(rename = "entries")]
    pub entries: Vec<AiSearchEntry>,
    #[serde(rename = "reason", deserialize_with = "required_nullable")]
    pub reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiTestTargetTokenField {
    #[serde(rename = "max_tokens")]
    Maxtokens,
    #[serde(rename = "max_completion_tokens")]
    Maxcompletiontokens,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiTestTarget {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "tokenField")]
    pub token_field: AiTestTargetTokenField,
}
