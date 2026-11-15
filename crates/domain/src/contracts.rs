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
