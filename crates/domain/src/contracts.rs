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
    #[serde(rename = "RenameSourceLink")]
    RenameSourceLink {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: RenameSourceLinkPayload,
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
    #[serde(rename = "SavePlanning")]
    SavePlanning {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: SavePlanningPayload,
    },
    #[serde(rename = "StartPlanningTask")]
    StartPlanningTask {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: StartPlanningTaskPayload,
    },
    #[serde(rename = "CancelPlanningTask")]
    CancelPlanningTask {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: CancelPlanningTaskPayload,
    },
    #[serde(rename = "UsePlanningResult")]
    UsePlanningResult {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: UsePlanningResultPayload,
    },
    #[serde(rename = "SaveReview")]
    SaveReview {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: SaveReviewPayload,
    },
    #[serde(rename = "SetReviewHandled")]
    SetReviewHandled {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: SetReviewHandledPayload,
    },
    #[serde(rename = "DeleteReviewThread")]
    DeleteReviewThread {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: DeleteReviewThreadPayload,
    },
    #[serde(rename = "StartReviewTask")]
    StartReviewTask {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: StartReviewTaskPayload,
    },
    #[serde(rename = "CancelReviewTask")]
    CancelReviewTask {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: CancelReviewTaskPayload,
    },
    #[serde(rename = "AcceptReviewCandidates")]
    AcceptReviewCandidates {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: AcceptReviewCandidatesPayload,
    },
    #[serde(rename = "DiscardReviewCandidate")]
    DiscardReviewCandidate {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: DiscardReviewCandidatePayload,
    },
    #[serde(rename = "SetUserLocks")]
    SetUserLocks {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: UserLocksPayload,
    },
    #[serde(rename = "RefreshSourceFile")]
    RefreshSourceFile {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "expectedWorkingRevision")]
        expected_working_revision: i64,
        #[serde(rename = "payload")]
        payload: RefreshSourceFilePayload,
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
    #[serde(
        rename = "candidateConflicts",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub candidate_conflicts: Option<Vec<CandidateConflict>>,
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
    #[serde(
        rename = "relativePath",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub relative_path: Option<String>,
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
    #[serde(rename = "planning.changed")]
    Planningchanged,
    #[serde(rename = "planningTask.changed")]
    PlanningTaskchanged,
    #[serde(rename = "draft.created")]
    Draftcreated,
    #[serde(rename = "review.changed")]
    Reviewchanged,
    #[serde(rename = "reviewTask.changed")]
    ReviewTaskchanged,
    #[serde(rename = "candidate.changed")]
    Candidatechanged,
    #[serde(rename = "locks.changed")]
    Lockschanged,
    #[serde(rename = "manuscript.readinessChanged")]
    ManuscriptreadinessChanged,
    #[serde(rename = "exportJob.changed")]
    ExportJobchanged,
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
    #[serde(
        rename = "relativePath",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub relative_path: Option<String>,
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
#[serde(deny_unknown_fields)]
pub struct PlanningBrief {
    #[serde(rename = "topic")]
    pub topic: String,
    #[serde(rename = "language")]
    pub language: String,
    #[serde(rename = "audience")]
    pub audience: String,
    #[serde(rename = "style")]
    pub style: String,
    #[serde(rename = "lengthHint")]
    pub length_hint: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutlineNode {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "depth")]
    pub depth: i64,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "keyPoints")]
    pub key_points: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanningEvidenceChoiceMode {
    #[serde(rename = "link_only")]
    Linkonly,
    #[serde(rename = "extracted_text")]
    Extractedtext,
    #[serde(rename = "text_only")]
    Textonly,
    #[serde(rename = "visual_input")]
    Visualinput,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningEvidenceChoice {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "mode")]
    pub mode: PlanningEvidenceChoiceMode,
    #[serde(rename = "start")]
    pub start: i64,
    #[serde(rename = "end")]
    pub end: i64,
    #[serde(rename = "visualId")]
    pub visual_id: String,
    #[serde(rename = "allowUnknownImages")]
    pub allow_unknown_images: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningContent {
    #[serde(rename = "brief")]
    pub brief: PlanningBrief,
    #[serde(rename = "nodes")]
    pub nodes: Vec<OutlineNode>,
    #[serde(rename = "instruction")]
    pub instruction: String,
    #[serde(rename = "evidence")]
    pub evidence: Vec<PlanningEvidenceChoice>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningTask {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "operation")]
    pub operation: String,
    #[serde(rename = "application")]
    pub application: String,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "run")]
    pub run: AiRun,
    #[serde(rename = "preview", deserialize_with = "required_nullable")]
    pub preview: Option<String>,
    #[serde(rename = "metadata", deserialize_with = "required_nullable")]
    pub metadata: Option<PlanningTaskMetadata>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningState {
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "content")]
    pub content: PlanningContent,
    #[serde(rename = "reserved")]
    pub reserved: bool,
    #[serde(rename = "tasks")]
    pub tasks: Vec<PlanningTask>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningEvidence {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceRevision")]
    pub source_revision: i64,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
    #[serde(rename = "level")]
    pub level: String,
    #[serde(rename = "location")]
    pub location: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "artifactId", deserialize_with = "required_nullable")]
    pub artifact_id: Option<String>,
    #[serde(rename = "extractor")]
    pub extractor: String,
    #[serde(rename = "warnings")]
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanningPreparationRequestOperation {
    #[serde(rename = "generate_outline")]
    Generateoutline,
    #[serde(rename = "adjust_outline")]
    Adjustoutline,
    #[serde(rename = "generate_initial_draft")]
    Generateinitialdraft,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningPreparationRequest {
    #[serde(rename = "operation")]
    pub operation: PlanningPreparationRequestOperation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningPreparation {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
    #[serde(rename = "planningRevision")]
    pub planning_revision: i64,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "manifestHash")]
    pub manifest_hash: String,
    #[serde(rename = "evidence")]
    pub evidence: Vec<PlanningEvidence>,
    #[serde(rename = "warnings")]
    pub warnings: Vec<String>,
    #[serde(rename = "estimatedInputTokens")]
    pub estimated_input_tokens: i64,
    #[serde(rename = "configuration")]
    pub configuration: AiResolvedConfig,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningVisualAction {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "index")]
    pub index: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningVisual {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "sourceRevision")]
    pub source_revision: i64,
    #[serde(rename = "index")]
    pub index: i64,
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "hash", deserialize_with = "required_nullable")]
    pub hash: Option<String>,
    #[serde(rename = "size")]
    pub size: i64,
    #[serde(rename = "width")]
    pub width: i64,
    #[serde(rename = "height")]
    pub height: i64,
    #[serde(rename = "transformation")]
    pub transformation: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavePlanningPayload {
    #[serde(rename = "content")]
    pub content: PlanningContent,
    #[serde(rename = "group")]
    pub group: EditGroup,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartPlanningTaskPayload {
    #[serde(rename = "preparationId")]
    pub preparation_id: String,
    #[serde(rename = "retryOfTaskId", deserialize_with = "required_nullable")]
    pub retry_of_task_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelPlanningTaskPayload {
    #[serde(rename = "taskId")]
    pub task_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsePlanningResultPayload {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "expectedHistoryRevision")]
    pub expected_history_revision: i64,
    #[serde(rename = "explicit")]
    pub explicit: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningResultReference {
    #[serde(rename = "evidenceId")]
    pub evidence_id: String,
    #[serde(rename = "outlineNodeId")]
    pub outline_node_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningSectionMapping {
    #[serde(rename = "outlineNodeId")]
    pub outline_node_id: String,
    #[serde(rename = "blockIds")]
    pub block_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningTaskMetadata {
    #[serde(rename = "verificationHints")]
    pub verification_hints: Vec<String>,
    #[serde(rename = "planningNotes")]
    pub planning_notes: Vec<String>,
    #[serde(rename = "evidenceReferences")]
    pub evidence_references: Vec<PlanningResultReference>,
    #[serde(rename = "sectionMapping")]
    pub section_mapping: Vec<PlanningSectionMapping>,
    #[serde(rename = "evidence")]
    pub evidence: Vec<PlanningEvidence>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewRange {
    #[serde(rename = "blockId")]
    pub block_id: String,
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "start")]
    pub start: i64,
    #[serde(rename = "end")]
    pub end: i64,
    #[serde(rename = "quote")]
    pub quote: String,
    #[serde(rename = "wholeBlock")]
    pub whole_block: bool,
    #[serde(
        rename = "quoteHash",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub quote_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewSlot {
    #[serde(rename = "headingId")]
    pub heading_id: String,
    #[serde(rename = "beforeId")]
    pub before_id: String,
    #[serde(rename = "afterId", deserialize_with = "required_nullable")]
    pub after_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAnchor {
    #[serde(rename = "ranges")]
    pub ranges: Vec<ReviewRange>,
    #[serde(rename = "state")]
    pub state: String,
    #[serde(rename = "slot", deserialize_with = "required_nullable")]
    pub slot: Option<ReviewSlot>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewThreadKind {
    #[serde(rename = "question")]
    Question,
    #[serde(rename = "revision_note")]
    Revisionnote,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewThread {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: ReviewThreadKind,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "anchor")]
    pub anchor: ReviewAnchor,
    #[serde(rename = "handled")]
    pub handled: bool,
    #[serde(rename = "deleted")]
    pub deleted: bool,
    #[serde(rename = "language")]
    pub language: String,
    #[serde(rename = "evidence")]
    pub evidence: Vec<PlanningEvidenceChoice>,
    #[serde(rename = "decision", deserialize_with = "required_nullable")]
    pub decision: Option<ReviewUserDecision>,
    #[serde(rename = "userMessageIds")]
    pub user_message_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewCandidateRef {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "version")]
    pub version: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewCandidate {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "version")]
    pub version: i64,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "before")]
    pub before: Vec<Block>,
    #[serde(rename = "after")]
    pub after: Vec<Block>,
    #[serde(rename = "explanation")]
    pub explanation: String,
    #[serde(rename = "previewTruncated")]
    pub preview_truncated: bool,
    #[serde(rename = "detailNextCursor", deserialize_with = "required_nullable")]
    pub detail_next_cursor: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewTask {
    #[serde(rename = "run")]
    pub run: AiRun,
    #[serde(rename = "application")]
    pub application: String,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "answer", deserialize_with = "required_nullable")]
    pub answer: Option<String>,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewCard {
    #[serde(rename = "thread")]
    pub thread: ReviewThread,
    #[serde(rename = "candidate", deserialize_with = "required_nullable")]
    pub candidate: Option<ReviewCandidate>,
    #[serde(rename = "task", deserialize_with = "required_nullable")]
    pub task: Option<ReviewTask>,
    #[serde(rename = "sourceComparisons")]
    pub source_comparisons: Vec<ReviewComparison>,
    #[serde(rename = "answer", deserialize_with = "required_nullable")]
    pub answer: Option<ReviewAnswer>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewPage {
    #[serde(rename = "cards")]
    pub cards: Vec<ReviewCard>,
    #[serde(rename = "nextCursor", deserialize_with = "required_nullable")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveReviewPayload {
    #[serde(rename = "thread")]
    pub thread: ReviewThread,
    #[serde(rename = "expectedRequestVersion")]
    pub expected_request_version: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetReviewHandledPayload {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(rename = "handled")]
    pub handled: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteReviewThreadPayload {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(rename = "discardCandidate")]
    pub discard_candidate: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartReviewTaskPayload {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(
        rename = "messageIds",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub message_ids: Option<Vec<String>>,
    #[serde(
        rename = "retryOfRunId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub retry_of_run_id: Option<Option<String>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelReviewTaskPayload {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptReviewCandidatesPayload {
    #[serde(rename = "candidates")]
    pub candidates: Vec<ReviewCandidateRef>,
    #[serde(rename = "expectedHistoryRevision")]
    pub expected_history_revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscardReviewCandidatePayload {
    #[serde(rename = "candidate")]
    pub candidate: ReviewCandidateRef,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewUserDecisionDecision {
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "discarded")]
    Discarded,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewUserDecision {
    #[serde(rename = "candidateId")]
    pub candidate_id: String,
    #[serde(rename = "decision")]
    pub decision: ReviewUserDecisionDecision,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewComparison {
    #[serde(rename = "blockId")]
    pub block_id: String,
    #[serde(rename = "before")]
    pub before: Block,
    #[serde(rename = "after", deserialize_with = "required_nullable")]
    pub after: Option<Block>,
    #[serde(rename = "previewTruncated")]
    pub preview_truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewMessageAuthor {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "ai")]
    Ai,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewMessage {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "sequence")]
    pub sequence: i64,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
    #[serde(rename = "author")]
    pub author: ReviewMessageAuthor,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "requestUserId")]
    pub request_user_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewMessagePage {
    #[serde(rename = "messages")]
    pub messages: Vec<ReviewMessage>,
    #[serde(rename = "nextCursor", deserialize_with = "required_nullable")]
    pub next_cursor: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateConflict {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "version")]
    pub version: i64,
    #[serde(rename = "reason")]
    pub reason: String,
    #[serde(rename = "affectedIds")]
    pub affected_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAnswer {
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "requestVersion")]
    pub request_version: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserLocksPayload {
    #[serde(rename = "blockIds")]
    pub block_ids: Vec<String>,
    #[serde(rename = "locked")]
    pub locked: bool,
    #[serde(rename = "all")]
    pub all: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserLock {
    #[serde(rename = "blockId")]
    pub block_id: String,
    #[serde(rename = "revision")]
    pub revision: i64,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedBaseline {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "sequence")]
    pub sequence: i64,
    #[serde(rename = "manifestHash")]
    pub manifest_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinalizationState {
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "locks")]
    pub locks: Vec<UserLock>,
    #[serde(rename = "reservedBlockIds")]
    pub reserved_block_ids: Vec<String>,
    #[serde(rename = "finalized")]
    pub finalized: bool,
    #[serde(rename = "baseline", deserialize_with = "required_nullable")]
    pub baseline: Option<ApprovedBaseline>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportRequestFormat {
    #[serde(rename = "txt")]
    Txt,
    #[serde(rename = "md")]
    Md,
    #[serde(rename = "docx")]
    Docx,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    #[serde(rename = "format")]
    pub format: ExportRequestFormat,
    #[serde(
        rename = "expectedBodyHash",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub expected_body_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportControl {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "attempt")]
    pub attempt: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportRetryMode {
    #[serde(rename = "retained")]
    Retained,
    #[serde(rename = "recapture")]
    Recapture,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRetry {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "mode")]
    pub mode: ExportRetryMode,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    #[serde(
        rename = "expectedBodyHash",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub expected_body_hash: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportJobFormat {
    #[serde(rename = "txt")]
    Txt,
    #[serde(rename = "md")]
    Md,
    #[serde(rename = "docx")]
    Docx,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExportJobStatus {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(rename = "interrupted")]
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportJob {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "format")]
    pub format: ExportJobFormat,
    #[serde(rename = "status")]
    pub status: ExportJobStatus,
    #[serde(rename = "attempt")]
    pub attempt: i64,
    #[serde(rename = "snapshotHash")]
    pub snapshot_hash: String,
    #[serde(rename = "bodyHash")]
    pub body_hash: String,
    #[serde(rename = "capturedRevision")]
    pub captured_revision: i64,
    #[serde(rename = "serializerVersion")]
    pub serializer_version: String,
    #[serde(rename = "filename")]
    pub filename: String,
    #[serde(rename = "artifactHash", deserialize_with = "required_nullable")]
    pub artifact_hash: Option<String>,
    #[serde(rename = "size")]
    pub size: i64,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
    #[serde(rename = "inputRetained")]
    pub input_retained: bool,
    #[serde(rename = "capturedFinalized")]
    pub captured_finalized: bool,
    #[serde(rename = "capturedBaseline", deserialize_with = "required_nullable")]
    pub captured_baseline: Option<String>,
    #[serde(rename = "delivery", deserialize_with = "required_nullable")]
    pub delivery: Option<DeliveryReceipt>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedCopy {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "bodyHash")]
    pub body_hash: String,
    #[serde(rename = "capturedRevision")]
    pub captured_revision: i64,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAction {
    #[serde(rename = "deliveryId")]
    pub delivery_id: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "artifactHash")]
    pub artifact_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeliveryReceiptStatus {
    #[serde(rename = "intent")]
    Intent,
    #[serde(rename = "saved")]
    Saved,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "failed")]
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryReceipt {
    #[serde(rename = "deliveryId")]
    pub delivery_id: String,
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "artifactHash")]
    pub artifact_hash: String,
    #[serde(rename = "status")]
    pub status: DeliveryReceiptStatus,
    #[serde(rename = "error", deserialize_with = "required_nullable")]
    pub error: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    #[serde(rename = "expectedBodyHash")]
    pub expected_body_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClipboardAction {
    #[serde(rename = "deliveryId")]
    pub delivery_id: String,
    #[serde(rename = "preparationId")]
    pub preparation_id: String,
    #[serde(rename = "bodyHash")]
    pub body_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ManuscriptIdentityWorkspaceStage {
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "draft")]
    Draft,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManuscriptIdentity {
    #[serde(rename = "workingRevision")]
    pub working_revision: i64,
    #[serde(rename = "bodyHash")]
    pub body_hash: String,
    #[serde(rename = "workspaceStage")]
    pub workspace_stage: ManuscriptIdentityWorkspaceStage,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshSourceFilePayload {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "intakeId")]
    pub intake_id: String,
    #[serde(rename = "hash")]
    pub hash: String,
    #[serde(
        rename = "relativePath",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub relative_path: Option<String>,
    #[serde(rename = "expectedSourceRevision")]
    pub expected_source_revision: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceDirectoryAssociation {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "name")]
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceDirectoryEntry {
    #[serde(rename = "intake")]
    pub intake: Intake,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReferenceDirectoryOutcomeStatus {
    #[serde(rename = "skipped")]
    Skipped,
    #[serde(rename = "error")]
    Error,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceDirectoryOutcome {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    #[serde(rename = "status")]
    pub status: ReferenceDirectoryOutcomeStatus,
    #[serde(rename = "code")]
    pub code: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceDirectoryBatch {
    #[serde(rename = "association")]
    pub association: ReferenceDirectoryAssociation,
    #[serde(rename = "entries")]
    pub entries: Vec<ReferenceDirectoryEntry>,
    #[serde(rename = "outcomes")]
    pub outcomes: Vec<ReferenceDirectoryOutcome>,
    #[serde(rename = "truncated")]
    pub truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenameSourceLinkPayload {
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[serde(rename = "expectedSourceRevision")]
    pub expected_source_revision: i64,
    #[serde(rename = "title")]
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownProject {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "revision")]
    pub revision: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateMarkdownProject {
    #[serde(rename = "text")]
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveMarkdownProject {
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(
        rename = "outlineRevision",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub outline_revision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarkdownWritingActionKind {
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "draft")]
    Draft,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownWritingAction {
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownWritingActionKind,
    #[serde(rename = "brief")]
    pub brief: String,
    #[serde(rename = "outline")]
    pub outline: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(
        rename = "outlineRevision",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub outline_revision: Option<String>,
    #[serde(
        rename = "conversationId",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub conversation_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownWritingResult {
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "text")]
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownExchangeReview {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "documents")]
    pub documents: Vec<MarkdownExchangeDocument>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarkdownDocumentKind {
    #[serde(rename = "manuscript")]
    Manuscript,
    #[serde(rename = "outline")]
    Outline,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownDocument {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "revision", deserialize_with = "required_nullable")]
    pub revision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveMarkdownDocument {
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "revision", deserialize_with = "required_nullable")]
    pub revision: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownRange {
    #[serde(rename = "start")]
    pub start: i64,
    #[serde(rename = "end")]
    pub end: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownAnchor {
    #[serde(rename = "sourceRevision")]
    pub source_revision: String,
    #[serde(rename = "start")]
    pub start: i64,
    #[serde(rename = "end")]
    pub end: i64,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "quote")]
    pub quote: String,
    #[serde(rename = "structure")]
    pub structure: String,
    #[serde(rename = "before")]
    pub before: Vec<String>,
    #[serde(rename = "after")]
    pub after: Vec<String>,
    #[serde(rename = "resolvedStart", deserialize_with = "required_nullable")]
    pub resolved_start: Option<i64>,
    #[serde(rename = "resolvedEnd", deserialize_with = "required_nullable")]
    pub resolved_end: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownLock {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "anchors")]
    pub anchors: Vec<MarkdownAnchor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MarkdownCommentStatus {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "resolved")]
    Resolved,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownComment {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "anchor")]
    pub anchor: MarkdownAnchor,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "status")]
    pub status: MarkdownCommentStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownAnnotations {
    #[serde(rename = "locks")]
    pub locks: Vec<MarkdownLock>,
    #[serde(rename = "comments")]
    pub comments: Vec<MarkdownComment>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum MarkdownAnnotationAction {
    #[serde(rename = "lock")]
    Lock {
        #[serde(rename = "revision")]
        revision: String,
        #[serde(rename = "ranges")]
        ranges: Vec<MarkdownRange>,
    },
    #[serde(rename = "comment")]
    Comment {
        #[serde(rename = "revision")]
        revision: String,
        #[serde(rename = "range")]
        range: MarkdownRange,
        #[serde(rename = "text")]
        text: String,
    },
    #[serde(rename = "unlock")]
    Unlock {
        #[serde(rename = "id")]
        id: String,
    },
    #[serde(rename = "resolve")]
    Resolve {
        #[serde(rename = "id")]
        id: String,
    },
    #[serde(rename = "reposition")]
    Reposition {
        #[serde(rename = "id")]
        id: String,
        #[serde(rename = "revision")]
        revision: String,
        #[serde(rename = "range")]
        range: MarkdownRange,
    },
    #[serde(rename = "edit")]
    Edit {
        #[serde(rename = "id")]
        id: String,
        #[serde(rename = "revision")]
        revision: String,
        #[serde(rename = "previousText")]
        previous_text: String,
        #[serde(rename = "text")]
        text: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownScopedAction {
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(rename = "commentId")]
    pub comment_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownScopedApply {
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(rename = "commentId")]
    pub comment_id: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "range")]
    pub range: MarkdownRange,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownScopedResult {
    #[serde(rename = "actionId")]
    pub action_id: String,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "range")]
    pub range: MarkdownRange,
    #[serde(rename = "fingerprint")]
    pub fingerprint: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkdownExchangeDocument {
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "baseRevision", deserialize_with = "required_nullable")]
    pub base_revision: Option<String>,
    #[serde(rename = "currentRevision", deserialize_with = "required_nullable")]
    pub current_revision: Option<String>,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "conflict", deserialize_with = "required_nullable")]
    pub conflict: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSelection {
    #[serde(rename = "range")]
    pub range: MarkdownRange,
    #[serde(rename = "quote")]
    pub quote: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentAttachment {
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "revision", deserialize_with = "required_nullable")]
    pub revision: Option<String>,
    #[serde(rename = "sourceDigest")]
    pub source_digest: String,
    #[serde(rename = "selection", deserialize_with = "required_nullable")]
    pub selection: Option<AgentSelection>,
    #[serde(rename = "buffer", deserialize_with = "required_nullable")]
    pub buffer: Option<String>,
    #[serde(
        rename = "research",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub research: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentContext {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "revision", deserialize_with = "required_nullable")]
    pub revision: Option<String>,
    #[serde(rename = "sourceDigest")]
    pub source_digest: String,
    #[serde(rename = "selection", deserialize_with = "required_nullable")]
    pub selection: Option<AgentSelection>,
    #[serde(
        rename = "batch",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub batch: Option<Box<AgentBatchContext>>,
    #[serde(
        rename = "research",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub research: Option<Box<AgentResearch>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentCreateSession {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSendTurn {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "instruction")]
    pub instruction: String,
    #[serde(rename = "attachment")]
    pub attachment: AgentAttachment,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentProposal {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "context")]
    pub context: AgentContext,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(
        rename = "batch",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub batch: Option<AgentBatchRevision>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentTurnStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "completed")]
    Completed,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "cancelled")]
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentTurnOutcome {
    #[serde(rename = "applied")]
    Applied,
    #[serde(rename = "discarded")]
    Discarded,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTurn {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "context")]
    pub context: AgentContext,
    #[serde(rename = "status")]
    pub status: AgentTurnStatus,
    #[serde(rename = "errorCode", deserialize_with = "required_nullable")]
    pub error_code: Option<String>,
    #[serde(rename = "proposal", deserialize_with = "required_nullable")]
    pub proposal: Option<AgentProposal>,
    #[serde(rename = "instruction")]
    pub instruction: String,
    #[serde(rename = "reply")]
    pub reply: String,
    #[serde(rename = "outcome", deserialize_with = "required_nullable")]
    pub outcome: Option<AgentTurnOutcome>,
    #[serde(rename = "applyResult", deserialize_with = "required_nullable")]
    pub apply_result: Option<AgentApplyResult>,
    #[serde(rename = "applyError", deserialize_with = "required_nullable")]
    pub apply_error: Option<String>,
    #[serde(rename = "attachment")]
    pub attachment: AgentAttachment,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSession {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "turns")]
    pub turns: Vec<AgentTurn>,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "generations")]
    pub generations: Vec<AgentGeneration>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentApply {
    #[serde(rename = "proposalId")]
    pub proposal_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum AgentEvent {
    #[serde(rename = "text")]
    Text {
        #[serde(rename = "sequence")]
        sequence: i64,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "text")]
        text: String,
    },
    #[serde(rename = "progress")]
    Progress {
        #[serde(rename = "sequence")]
        sequence: i64,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "text")]
        text: String,
    },
    #[serde(rename = "proposal")]
    Proposal {
        #[serde(rename = "sequence")]
        sequence: i64,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "proposal")]
        proposal: AgentProposal,
    },
    #[serde(rename = "final")]
    Final {
        #[serde(rename = "sequence")]
        sequence: i64,
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "status")]
        status: AgentTurnStatus,
        #[serde(rename = "reply")]
        reply: String,
        #[serde(rename = "errorCode", deserialize_with = "required_nullable")]
        error_code: Option<String>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentApplyResult {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "kind")]
    pub kind: MarkdownDocumentKind,
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(rename = "proposalId")]
    pub proposal_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentModel {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "label")]
    pub label: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentEngineStatus {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "not_configured")]
    Notconfigured,
    #[serde(rename = "not_authenticated")]
    Notauthenticated,
    #[serde(rename = "unavailable")]
    Unavailable,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentEngine {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "label")]
    pub label: String,
    #[serde(rename = "available")]
    pub available: bool,
    #[serde(
        rename = "status",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub status: Option<AgentEngineStatus>,
    #[serde(rename = "models")]
    pub models: Vec<AgentModel>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentGenerationKind {
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "draft")]
    Draft,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGeneration {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "kind")]
    pub kind: AgentGenerationKind,
    #[serde(rename = "instruction")]
    pub instruction: String,
    #[serde(rename = "status")]
    pub status: AgentTurnStatus,
    #[serde(rename = "text")]
    pub text: String,
    #[serde(rename = "errorCode", deserialize_with = "required_nullable")]
    pub error_code: Option<String>,
    #[serde(rename = "revision")]
    pub revision: String,
    #[serde(rename = "outlineRevision", deserialize_with = "required_nullable")]
    pub outline_revision: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConversationHistory {
    #[serde(rename = "currentId", deserialize_with = "required_nullable")]
    pub current_id: Option<String>,
    #[serde(rename = "conversations")]
    pub conversations: Vec<AgentConversationSummary>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentConversationActionAction {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "rename")]
    Rename,
    #[serde(rename = "new")]
    New,
    #[serde(rename = "discard")]
    Discard,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConversationAction {
    #[serde(rename = "action")]
    pub action: AgentConversationActionAction,
    #[serde(rename = "value")]
    pub value: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConversationSummary {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentEditScope {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "selection")]
    pub selection: AgentSelection,
    #[serde(rename = "commentIds")]
    pub comment_ids: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentUnresolvedReason {
    #[serde(rename = "locked")]
    Locked,
    #[serde(rename = "detached")]
    Detached,
    #[serde(rename = "clarification")]
    Clarification,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentUnresolved {
    #[serde(rename = "commentIds")]
    pub comment_ids: Vec<String>,
    #[serde(rename = "reason")]
    pub reason: AgentUnresolvedReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentBatchContext {
    #[serde(rename = "comments")]
    pub comments: Vec<MarkdownComment>,
    #[serde(rename = "locks")]
    pub locks: Vec<MarkdownLock>,
    #[serde(rename = "scopes")]
    pub scopes: Vec<AgentEditScope>,
    #[serde(rename = "unresolved")]
    pub unresolved: Vec<AgentUnresolved>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentBatchChange {
    #[serde(rename = "scopeId")]
    pub scope_id: String,
    #[serde(rename = "text")]
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentBatchRevision {
    #[serde(rename = "changes")]
    pub changes: Vec<AgentBatchChange>,
    #[serde(rename = "unresolved")]
    pub unresolved: Vec<AgentUnresolved>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentResearchSource {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "title")]
    pub title: String,
    #[serde(rename = "url", deserialize_with = "required_nullable")]
    pub url: Option<String>,
    #[serde(rename = "excerpt")]
    pub excerpt: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentResearchStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "partial")]
    Partial,
    #[serde(rename = "unavailable")]
    Unavailable,
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "cancelled")]
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentResearch {
    #[serde(rename = "status")]
    pub status: AgentResearchStatus,
    #[serde(rename = "sources")]
    pub sources: Vec<AgentResearchSource>,
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
pub enum AiProviderServicePreset {
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "deepseek")]
    Deepseek,
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
    #[serde(
        rename = "servicePreset",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub service_preset: Option<AiProviderServicePreset>,
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
    #[serde(
        rename = "defaultParameters",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nonnull"
    )]
    pub default_parameters: Option<AiParameters>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiParameters {
    #[serde(rename = "temperatureMilli", deserialize_with = "required_nullable")]
    pub temperature_milli: Option<i64>,
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
    #[serde(rename = "encrypted_file")]
    Encryptedfile,
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
#[serde(deny_unknown_fields)]
pub struct AiTestTarget {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}
