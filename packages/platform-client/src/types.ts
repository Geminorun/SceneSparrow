export const MARKDOWN_EXCHANGE_MAX_BYTES =
  10 * 1024 * 1024 + 256 * 1024 + 65536;

import type {
  AgentCreateSession,
  AgentSendTurn,
  AgentSession,
  AgentTurn,
  AgentApplyResult,
  AgentEvent,
  MarkdownProject,
  MarkdownDocument,
  MarkdownAnnotations,
  MarkdownAnnotationAction,
  MarkdownScopedAction,
  MarkdownScopedApply,
  MarkdownScopedResult,
  MarkdownDocumentKind,
  SaveMarkdownDocument,
  MarkdownExchangeReview,
  MarkdownWritingAction,
  MarkdownWritingResult,
  SaveMarkdownProject,
  ManuscriptIdentity,
  CopyRequest,
  PreparedCopy,
  ClipboardAction,
  ExportRequest,
  ExportControl,
  ExportRetry,
  ExportJob,
  DeliveryAction,
  DeliveryReceipt,
  FinalizationState,
  ReviewPage,
  ReviewCandidate,
  ReviewComparison,
  ReviewMessagePage,
  PlanningState,
  PlanningPreparation,
  PlanningPreparationRequest,
  PlanningTask,
  PlanningVisual,
  PlanningVisualAction,
  AiSettingsView,
  AiSettingsUpdate,
  AiCredentialUpdate,
  AiReadiness,
  AiDiscovery,
  AiTestAction,
  AiTestTarget,
  AiTestReceipt,
  AiRun,
  HistoryErrorDetails,
  SourcePage,
  Intake,
  ReferenceDirectoryAssociation,
  ReferenceDirectoryBatch,
  DocumentAction,
  DocumentJob,
  ExtractionPage,
  ProjectEvent,
  HistoryState,
  CreateProject,
  EnsureProject,
  RenameProject,
  ManuscriptState,
  ManuscriptCommand,
  CommandReceipt,
  Health,
  ProjectResponse,
} from "@scenesparrow/contracts";

export interface RecentProject {
  id: string;
  title: string;
}

export type { AgentEngine } from "@scenesparrow/contracts";
import type { AgentEngine } from "@scenesparrow/contracts";

export interface ExternalWritingClient {
  catalog?(): Promise<AgentEngine[]>;
  testDeepseek?(request: AiTestAction): Promise<AiTestReceipt>;
  create(projectId: string, request: AgentCreateSession): Promise<AgentSession>;
  read(projectId: string, sessionId: string): Promise<AgentSession>;
  close(projectId: string, sessionId: string): Promise<void>;
  send(
    projectId: string,
    sessionId: string,
    request: AgentSendTurn,
  ): Promise<AgentTurn>;
  cancel(
    projectId: string,
    sessionId: string,
    turnId: string,
  ): Promise<AgentTurn>;
  apply(
    projectId: string,
    sessionId: string,
    turnId: string,
    proposalId: string,
  ): Promise<AgentApplyResult>;
  stream(
    projectId: string,
    sessionId: string,
    turnId: string,
    after: number,
    handler: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PlatformClient {
  agent?: ExternalWritingClient;
  markdownProjects?: {
    create(text: string): Promise<MarkdownProject>;
    download(
      id: string,
      revision: string,
      outlineRevision: string | null,
    ): Promise<Uint8Array>;
    review(id: string, bytes: Uint8Array): Promise<MarkdownExchangeReview>;
    write(
      id: string,
      action: MarkdownWritingAction,
    ): Promise<MarkdownWritingResult>;
    annotations(
      id: string,
      kind: MarkdownDocumentKind,
    ): Promise<MarkdownAnnotations>;
    annotate(
      id: string,
      kind: MarkdownDocumentKind,
      action: MarkdownAnnotationAction,
    ): Promise<MarkdownAnnotations>;
    scoped(
      id: string,
      kind: MarkdownDocumentKind,
      action: MarkdownScopedAction,
    ): Promise<MarkdownScopedResult>;
    applyScoped(
      id: string,
      kind: MarkdownDocumentKind,
      action: MarkdownScopedApply,
    ): Promise<MarkdownDocument>;
    readDocument(
      id: string,
      kind: MarkdownDocumentKind,
    ): Promise<MarkdownDocument>;
    saveDocument(
      id: string,
      kind: MarkdownDocumentKind,
      request: SaveMarkdownDocument,
    ): Promise<MarkdownDocument>;
    read(id: string): Promise<MarkdownProject>;
    save(id: string, request: SaveMarkdownProject): Promise<MarkdownProject>;
  };
  readManuscriptIdentity?(): Promise<ManuscriptIdentity>;
  prepareCopy(request: CopyRequest): Promise<PreparedCopy>;

  readExports(): Promise<ExportJob[]>;
  startExport(request: ExportRequest): Promise<ExportJob>;
  exportJob(id: string): Promise<ExportJob>;
  cancelExport(id: string, request: ExportControl): Promise<ExportJob>;
  retryExport(id: string, request: ExportRetry): Promise<ExportJob>;
  exportBytes(id: string): Promise<Uint8Array>;
  writePreparedClipboard?(action: ClipboardAction): Promise<void>;
  saveExport?(action: DeliveryAction): Promise<DeliveryReceipt | null>;

  readFinalization(): Promise<FinalizationState>;
  readReviews(after?: string): Promise<ReviewPage>;
  reviewCandidate(id: string, offset?: number): Promise<ReviewCandidate>;
  reviewMessages(id: string, before?: number): Promise<ReviewMessagePage>;
  reviewSourceComparison(id: string): Promise<ReviewComparison>;
  readPlanning(): Promise<PlanningState>;
  preparePlanning(
    request: PlanningPreparationRequest,
  ): Promise<PlanningPreparation>;
  planningTask(id: string): Promise<PlanningTask>;
  preparePlanningVisual(action: PlanningVisualAction): Promise<PlanningVisual>;
  planningVisual(id: string): Promise<PlanningVisual>;
  cancelPlanningVisual(id: string): Promise<PlanningVisual>;
  readAiSettings(): Promise<AiSettingsView>;
  updateAiSettings(update: AiSettingsUpdate): Promise<AiSettingsView>;
  updateAiCredential(update: AiCredentialUpdate): Promise<AiSettingsView>;
  deleteAiCredential(update: AiCredentialUpdate): Promise<AiSettingsView>;
  resolveAiConfiguration(): Promise<AiReadiness>;
  discoverAiModels(providerId: string): Promise<AiDiscovery>;
  prepareAiTest(target: AiTestTarget): Promise<AiReadiness>;
  testAiConnection(action: AiTestAction): Promise<AiTestReceipt>;
  readAiRun(runId: string): Promise<AiRun>;
  readAiResult(runId: string): Promise<Uint8Array>;
  cancelAiRun(runId: string): Promise<AiRun>;

  readSources(after?: string): Promise<SourcePage>;
  readReferenceDirectory?(): Promise<ReferenceDirectoryAssociation | null>;
  pickReferenceDirectory?(
    signal?: AbortSignal,
  ): Promise<ReferenceDirectoryBatch | null>;
  refreshReferenceDirectory?(
    capabilityId: string,
    signal?: AbortSignal,
  ): Promise<ReferenceDirectoryBatch>;
  uploadFile(
    file: File,
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Intake>;
  pickFileIntake?(
    signal?: AbortSignal,
    progress?: (loaded: number, total: number) => void,
  ): Promise<Intake | null>;
  cancelIntake(id: string): Promise<unknown>;
  documentAction(action: DocumentAction): Promise<DocumentJob>;
  documentJob(id: string): Promise<DocumentJob>;
  extractionPage(id: string, offset?: number): Promise<ExtractionPage>;
  subscribeEvents(
    handler: (event: ProjectEvent) => void,
    resync: () => void,
  ): () => void;
  openExternalLink(url: string): Promise<void>;

  readHistory(): Promise<HistoryState>;
  readManuscript(): Promise<ManuscriptState>;
  executeManuscript(command: ManuscriptCommand): Promise<CommandReceipt>;
  commandReceipt(requestId: string): Promise<CommandReceipt>;
  readRecentProjects?(): Promise<RecentProject[]>;
  openRecentProject?(id: string): Promise<void>;
  pickProject?(recover?: boolean): Promise<void>;
  backupProject?(): Promise<{ id: string }>;
  onCloseAborted?(handler: () => void): () => void;
  onCloseRequested?(handler: () => Promise<boolean>): () => void;
  health(): Promise<Health>;
  readProject(): Promise<ProjectResponse>;
  createProject(command: CreateProject): Promise<ProjectResponse>;
  ensureProject(command: EnsureProject): Promise<ProjectResponse>;
  renameProject(command: RenameProject): Promise<ProjectResponse>;
}

export type BridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: HistoryErrorDetails };
export interface DesktopBridge {
  readManuscriptIdentity?(): Promise<BridgeResult<ManuscriptIdentity>>;
  readExports(): Promise<BridgeResult<ExportJob[]>>;
  prepareCopy(request: CopyRequest): Promise<BridgeResult<PreparedCopy>>;

  startExport(request: ExportRequest): Promise<BridgeResult<ExportJob>>;
  exportJob(id: string): Promise<BridgeResult<ExportJob>>;
  cancelExport(
    id: string,
    request: ExportControl,
  ): Promise<BridgeResult<ExportJob>>;
  retryExport(
    id: string,
    request: ExportRetry,
  ): Promise<BridgeResult<ExportJob>>;
  exportBytes(id: string): Promise<BridgeResult<Uint8Array>>;
  writePreparedClipboard(action: ClipboardAction): Promise<BridgeResult<null>>;
  saveExport(
    action: DeliveryAction,
  ): Promise<BridgeResult<DeliveryReceipt | null>>;

  readFinalization(): Promise<BridgeResult<FinalizationState>>;
  readReviews(after?: string): Promise<BridgeResult<ReviewPage>>;
  reviewCandidate(
    id: string,
    offset?: number,
  ): Promise<BridgeResult<ReviewCandidate>>;
  reviewMessages(
    id: string,
    before?: number,
  ): Promise<BridgeResult<ReviewMessagePage>>;
  reviewSourceComparison(id: string): Promise<BridgeResult<ReviewComparison>>;
  readPlanning(): Promise<BridgeResult<PlanningState>>;
  preparePlanning(
    request: PlanningPreparationRequest,
  ): Promise<BridgeResult<PlanningPreparation>>;
  planningTask(id: string): Promise<BridgeResult<PlanningTask>>;
  preparePlanningVisual(
    action: PlanningVisualAction,
  ): Promise<BridgeResult<PlanningVisual>>;
  planningVisual(id: string): Promise<BridgeResult<PlanningVisual>>;
  cancelPlanningVisual(id: string): Promise<BridgeResult<PlanningVisual>>;
  readAiSettings(): Promise<BridgeResult<AiSettingsView>>;
  updateAiSettings(
    update: AiSettingsUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  updateAiCredential(
    update: AiCredentialUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  deleteAiCredential(
    update: AiCredentialUpdate,
  ): Promise<BridgeResult<AiSettingsView>>;
  resolveAiConfiguration(): Promise<BridgeResult<AiReadiness>>;
  discoverAiModels(providerId: string): Promise<BridgeResult<AiDiscovery>>;
  prepareAiTest(target: AiTestTarget): Promise<BridgeResult<AiReadiness>>;
  testAiConnection(action: AiTestAction): Promise<BridgeResult<AiTestReceipt>>;
  readAiRun(runId: string): Promise<BridgeResult<AiRun>>;
  readAiResult(runId: string): Promise<BridgeResult<Uint8Array>>;
  cancelAiRun(runId: string): Promise<BridgeResult<AiRun>>;

  readSources(after?: string): Promise<BridgeResult<SourcePage>>;
  readReferenceDirectory?(): Promise<
    BridgeResult<ReferenceDirectoryAssociation | null>
  >;
  pickReferenceDirectory?(
    operationId: string,
  ): Promise<BridgeResult<ReferenceDirectoryBatch | null>>;
  refreshReferenceDirectory?(
    operationId: string,
    capabilityId: string,
  ): Promise<BridgeResult<ReferenceDirectoryBatch>>;
  cancelReferenceDirectoryBatch?(
    operationId: string,
  ): Promise<BridgeResult<null>>;
  pickFileIntake(id: string): Promise<BridgeResult<Intake | null>>;
  cancelFileSelection(id: string): Promise<BridgeResult<null>>;
  onFileIntakeProgress(
    id: string,
    handler: (loaded: number, total: number) => void,
  ): () => void;
  cancelIntake(id: string): Promise<BridgeResult<unknown>>;
  documentAction(action: DocumentAction): Promise<BridgeResult<DocumentJob>>;
  documentJob(id: string): Promise<BridgeResult<DocumentJob>>;
  extractionPage(
    id: string,
    offset: number,
  ): Promise<BridgeResult<ExtractionPage>>;
  subscribeEvents(
    handler: (event: ProjectEvent) => void,
    resync: () => void,
  ): () => void;
  openExternalLink(url: string): Promise<BridgeResult<null>>;

  health(): Promise<BridgeResult<Health>>;
  readProject(): Promise<BridgeResult<ProjectResponse>>;
  createProject(command: CreateProject): Promise<BridgeResult<ProjectResponse>>;
  ensureProject(command: EnsureProject): Promise<BridgeResult<ProjectResponse>>;
  renameProject(command: RenameProject): Promise<BridgeResult<ProjectResponse>>;
  readHistory(): Promise<BridgeResult<HistoryState>>;
  readManuscript(): Promise<BridgeResult<ManuscriptState>>;
  executeManuscript(
    command: ManuscriptCommand,
  ): Promise<BridgeResult<CommandReceipt>>;
  commandReceipt(requestId: string): Promise<BridgeResult<CommandReceipt>>;
  readRecentProjects?(): Promise<BridgeResult<RecentProject[]>>;
  openRecentProject?(id: string): Promise<BridgeResult<null>>;
  pickProject(recover?: boolean): Promise<BridgeResult<null>>;
  backupProject(): Promise<BridgeResult<{ id: string }>>;
  onCloseAborted(handler: () => void): () => void;
  onCloseRequested(handler: () => Promise<boolean>): () => void;
}
