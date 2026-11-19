import type { ReferenceDirectoryBatch } from "@scenesparrow/contracts";
import type { BridgeResult, DesktopBridge, PlatformClient } from "./types";
import { ApiError } from "./errors";
import { validateExternalLink } from "./links";

export function createDesktopClient(bridge: DesktopBridge): PlatformClient {
  async function unwrap<T>(promise: Promise<BridgeResult<T>>): Promise<T> {
    const result = await promise;
    if (!result.ok) throw new ApiError(result.code, result.details);
    return result.data;
  }
  async function directoryBatch<T extends ReferenceDirectoryBatch | null>(
    start: (id: string) => Promise<BridgeResult<T>>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new ApiError("DOCUMENT_JOB_INTERRUPTED");
    const id = crypto.randomUUID();
    const cancel = () => {
      void bridge.cancelReferenceDirectoryBatch?.(id).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const batch = await unwrap(start(id));
      if (signal?.aborted) {
        await Promise.allSettled(
          (batch?.entries ?? []).map(({ intake }) =>
            bridge.cancelIntake(intake.id),
          ),
        );
        throw new ApiError("DOCUMENT_JOB_INTERRUPTED");
      }
      return batch;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  return {
    ...(bridge.readPackageBase
      ? {
          readPackageBase: (
            ...args: Parameters<NonNullable<DesktopBridge["readPackageBase"]>>
          ) => unwrap(bridge.readPackageBase!(...args)),
        }
      : {}),
    ...(bridge.startProjectPackageExport
      ? {
          startProjectPackageExport: (
            ...args: Parameters<
              NonNullable<DesktopBridge["startProjectPackageExport"]>
            >
          ) => unwrap(bridge.startProjectPackageExport!(...args)),
        }
      : {}),
    ...(bridge.startWorkCopyPackageExport
      ? {
          startWorkCopyPackageExport: (
            ...args: Parameters<
              NonNullable<DesktopBridge["startWorkCopyPackageExport"]>
            >
          ) => unwrap(bridge.startWorkCopyPackageExport!(...args)),
        }
      : {}),
    ...(bridge.readPackageOperation
      ? {
          readPackageOperation: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readPackageOperation"]>
            >
          ) => unwrap(bridge.readPackageOperation!(...args)),
        }
      : {}),
    ...(bridge.controlPackageOperation
      ? {
          controlPackageOperation: (
            ...args: Parameters<
              NonNullable<DesktopBridge["controlPackageOperation"]>
            >
          ) => unwrap(bridge.controlPackageOperation!(...args)),
        }
      : {}),
    ...(bridge.createPackageIntake
      ? {
          createPackageIntake: (
            ...args: Parameters<
              NonNullable<DesktopBridge["createPackageIntake"]>
            >
          ) => unwrap(bridge.createPackageIntake!(...args)),
        }
      : {}),
    ...(bridge.readPackageIntake
      ? {
          readPackageIntake: (
            ...args: Parameters<NonNullable<DesktopBridge["readPackageIntake"]>>
          ) => unwrap(bridge.readPackageIntake!(...args)),
        }
      : {}),
    ...(bridge.uploadPackageChunk
      ? {
          uploadPackageChunk: (
            ...args: Parameters<
              NonNullable<DesktopBridge["uploadPackageChunk"]>
            >
          ) => unwrap(bridge.uploadPackageChunk!(...args)),
        }
      : {}),
    ...(bridge.controlPackageIntake
      ? {
          controlPackageIntake: (
            ...args: Parameters<
              NonNullable<DesktopBridge["controlPackageIntake"]>
            >
          ) => unwrap(bridge.controlPackageIntake!(...args)),
        }
      : {}),
    ...(bridge.inspectPackage
      ? {
          inspectPackage: (
            ...args: Parameters<NonNullable<DesktopBridge["inspectPackage"]>>
          ) => unwrap(bridge.inspectPackage!(...args)),
        }
      : {}),
    ...(bridge.readPackageInspection
      ? {
          readPackageInspection: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readPackageInspection"]>
            >
          ) => unwrap(bridge.readPackageInspection!(...args)),
        }
      : {}),
    ...(bridge.issuePackageRestoreTarget
      ? {
          issuePackageRestoreTarget: (
            ...args: Parameters<
              NonNullable<DesktopBridge["issuePackageRestoreTarget"]>
            >
          ) => unwrap(bridge.issuePackageRestoreTarget!(...args)),
        }
      : {}),
    ...(bridge.restorePackage
      ? {
          restorePackage: (
            ...args: Parameters<NonNullable<DesktopBridge["restorePackage"]>>
          ) => unwrap(bridge.restorePackage!(...args)),
        }
      : {}),
    ...(bridge.returnPackage
      ? {
          returnPackage: (
            ...args: Parameters<NonNullable<DesktopBridge["returnPackage"]>>
          ) => unwrap(bridge.returnPackage!(...args)),
        }
      : {}),
    ...(bridge.inspectLegacyMigration
      ? {
          inspectLegacyMigration: (
            ...args: Parameters<
              NonNullable<DesktopBridge["inspectLegacyMigration"]>
            >
          ) => unwrap(bridge.inspectLegacyMigration!(...args)),
        }
      : {}),
    ...(bridge.issueMigrationTarget
      ? {
          issueMigrationTarget: (
            ...args: Parameters<
              NonNullable<DesktopBridge["issueMigrationTarget"]>
            >
          ) => unwrap(bridge.issueMigrationTarget!(...args)),
        }
      : {}),
    ...(bridge.startLegacyMigration
      ? {
          startLegacyMigration: (
            ...args: Parameters<
              NonNullable<DesktopBridge["startLegacyMigration"]>
            >
          ) => unwrap(bridge.startLegacyMigration!(...args)),
        }
      : {}),
    ...(bridge.readMigrationOperation
      ? {
          readMigrationOperation: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readMigrationOperation"]>
            >
          ) => unwrap(bridge.readMigrationOperation!(...args)),
        }
      : {}),
    ...(bridge.controlMigration
      ? {
          controlMigration: (
            ...args: Parameters<NonNullable<DesktopBridge["controlMigration"]>>
          ) => unwrap(bridge.controlMigration!(...args)),
        }
      : {}),
    ...(bridge.inspectGraphRecovery
      ? {
          inspectGraphRecovery: (intent: string) =>
            unwrap(bridge.inspectGraphRecovery!(intent)),
        }
      : {}),
    ...(bridge.readFileGraph
      ? {
          readFileGraph: (
            ...args: Parameters<NonNullable<DesktopBridge["readFileGraph"]>>
          ) => unwrap(bridge.readFileGraph!(...args)),
        }
      : {}),
    ...(bridge.readGraphFiles
      ? {
          readGraphFiles: (
            ...args: Parameters<NonNullable<DesktopBridge["readGraphFiles"]>>
          ) => unwrap(bridge.readGraphFiles!(...args)),
        }
      : {}),
    ...(bridge.registerFileGraph
      ? {
          registerFileGraph: (
            ...args: Parameters<NonNullable<DesktopBridge["registerFileGraph"]>>
          ) => unwrap(bridge.registerFileGraph!(...args)),
        }
      : {}),
    ...(bridge.createWorkItem
      ? {
          createWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["createWorkItem"]>>
          ) => unwrap(bridge.createWorkItem!(...args)),
        }
      : {}),
    ...(bridge.readWorkItems
      ? {
          readWorkItems: (
            ...args: Parameters<NonNullable<DesktopBridge["readWorkItems"]>>
          ) => unwrap(bridge.readWorkItems!(...args)),
        }
      : {}),
    ...(bridge.readWorkItem
      ? {
          readWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["readWorkItem"]>>
          ) => unwrap(bridge.readWorkItem!(...args)),
        }
      : {}),
    ...(bridge.inspectWorkItem
      ? {
          inspectWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["inspectWorkItem"]>>
          ) => unwrap(bridge.inspectWorkItem!(...args)),
        }
      : {}),
    ...(bridge.acceptWorkCandidate
      ? {
          acceptWorkCandidate: (
            ...args: Parameters<
              NonNullable<DesktopBridge["acceptWorkCandidate"]>
            >
          ) => unwrap(bridge.acceptWorkCandidate!(...args)),
        }
      : {}),
    ...(bridge.discardWorkItem
      ? {
          discardWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["discardWorkItem"]>>
          ) => unwrap(bridge.discardWorkItem!(...args)),
        }
      : {}),
    ...(bridge.controlWorkItem
      ? {
          controlWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["controlWorkItem"]>>
          ) => unwrap(bridge.controlWorkItem!(...args)),
        }
      : {}),
    ...(bridge.readWorkOperation
      ? {
          readWorkOperation: (
            ...args: Parameters<NonNullable<DesktopBridge["readWorkOperation"]>>
          ) => unwrap(bridge.readWorkOperation!(...args)),
        }
      : {}),
    ...(bridge.readWorkCandidate
      ? {
          readWorkCandidate: (
            ...args: Parameters<NonNullable<DesktopBridge["readWorkCandidate"]>>
          ) => unwrap(bridge.readWorkCandidate!(...args)),
        }
      : {}),
    ...(bridge.readWorkChanges
      ? {
          readWorkChanges: (
            ...args: Parameters<NonNullable<DesktopBridge["readWorkChanges"]>>
          ) => unwrap(bridge.readWorkChanges!(...args)),
        }
      : {}),
    ...(bridge.readProductionFileLocks
      ? {
          readProductionFileLocks: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readProductionFileLocks"]>
            >
          ) => unwrap(bridge.readProductionFileLocks!(...args)),
        }
      : {}),
    ...(bridge.setProductionFileLocks
      ? {
          setProductionFileLocks: (
            ...args: Parameters<
              NonNullable<DesktopBridge["setProductionFileLocks"]>
            >
          ) => unwrap(bridge.setProductionFileLocks!(...args)),
        }
      : {}),
    ...(bridge.readGraphRecoveries
      ? {
          readGraphRecoveries: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readGraphRecoveries"]>
            >
          ) => unwrap(bridge.readGraphRecoveries!(...args)),
        }
      : {}),
    ...(bridge.readGraphRecoveryMembers
      ? {
          readGraphRecoveryMembers: (
            ...args: Parameters<
              NonNullable<DesktopBridge["readGraphRecoveryMembers"]>
            >
          ) => unwrap(bridge.readGraphRecoveryMembers!(...args)),
        }
      : {}),
    ...(bridge.downloadWorkCandidateMember
      ? {
          downloadWorkCandidateMember: (
            ...args: Parameters<
              NonNullable<DesktopBridge["downloadWorkCandidateMember"]>
            >
          ) => unwrap(bridge.downloadWorkCandidateMember!(...args)),
        }
      : {}),
    ...(bridge.downloadGraphRecoveryMember
      ? {
          downloadGraphRecoveryMember: (
            ...args: Parameters<
              NonNullable<DesktopBridge["downloadGraphRecoveryMember"]>
            >
          ) => unwrap(bridge.downloadGraphRecoveryMember!(...args)),
        }
      : {}),
    ...(bridge.revealWorkItem
      ? {
          revealWorkItem: (
            ...args: Parameters<NonNullable<DesktopBridge["revealWorkItem"]>>
          ) => unwrap(bridge.revealWorkItem!(...args)),
        }
      : {}),
    ...(bridge.inspectProjectFormat
      ? { inspectProjectFormat: () => unwrap(bridge.inspectProjectFormat!()) }
      : {}),
    ...(bridge.readAuthoredSourceRecoveryEvidence
      ? {
          readAuthoredSourceRecoveryEvidence: (intent: string) =>
            unwrap(bridge.readAuthoredSourceRecoveryEvidence!(intent)),
        }
      : {}),
    ...(bridge.readAuthoredSourceRecoveryVersion
      ? {
          readAuthoredSourceRecoveryVersion: (intent: string, source: string) =>
            unwrap(bridge.readAuthoredSourceRecoveryVersion!(intent, source)),
        }
      : {}),
    ...(bridge.readAuthoredSourceStatus
      ? {
          readAuthoredSourceStatus: () =>
            unwrap(bridge.readAuthoredSourceStatus!()),
        }
      : {}),
    ...(bridge.rescanAuthoredSource
      ? { rescanAuthoredSource: () => unwrap(bridge.rescanAuthoredSource!()) }
      : {}),
    ...(bridge.readAuthoredSourceCandidate
      ? {
          readAuthoredSourceCandidate: (id: string) =>
            unwrap(bridge.readAuthoredSourceCandidate!(id)),
        }
      : {}),
    ...(bridge.resolveAuthoredSource
      ? {
          resolveAuthoredSource: (
            body: Parameters<
              NonNullable<DesktopBridge["resolveAuthoredSource"]>
            >[0],
          ) => unwrap(bridge.resolveAuthoredSource!(body)),
        }
      : {}),
    ...(bridge.recoverAuthoredSource
      ? {
          recoverAuthoredSource: (
            body: Parameters<
              NonNullable<DesktopBridge["recoverAuthoredSource"]>
            >[0],
          ) => unwrap(bridge.recoverAuthoredSource!(body)),
        }
      : {}),
    ...(bridge.readAuthoredSource
      ? { readAuthoredSource: () => unwrap(bridge.readAuthoredSource!()) }
      : {}),
    ...(bridge.saveAuthoredSource
      ? {
          saveAuthoredSource: (
            body: Parameters<
              NonNullable<DesktopBridge["saveAuthoredSource"]>
            >[0],
          ) => unwrap(bridge.saveAuthoredSource!(body)),
        }
      : {}),
    ...(bridge.readReferenceDirectory
      ? {
          readReferenceDirectory: () =>
            unwrap(bridge.readReferenceDirectory!()),
        }
      : {}),
    ...(bridge.pickReferenceDirectory
      ? {
          pickReferenceDirectory: (signal?: AbortSignal) =>
            directoryBatch((id) => bridge.pickReferenceDirectory!(id), signal),
        }
      : {}),
    ...(bridge.refreshReferenceDirectory
      ? {
          refreshReferenceDirectory: (
            capabilityId: string,
            signal?: AbortSignal,
          ) =>
            directoryBatch(
              (id) => bridge.refreshReferenceDirectory!(id, capabilityId),
              signal,
            ),
        }
      : {}),
    ...(bridge.readManuscriptIdentity
      ? {
          readManuscriptIdentity: () =>
            unwrap(bridge.readManuscriptIdentity!()),
        }
      : {}),
    prepareCopy: (body) => unwrap(bridge.prepareCopy(body)),
    readExports: () => unwrap(bridge.readExports()),
    startExport: (body) => unwrap(bridge.startExport(body)),
    exportJob: (id) => unwrap(bridge.exportJob(id)),
    cancelExport: (id, body) => unwrap(bridge.cancelExport(id, body)),
    retryExport: (id, body) => unwrap(bridge.retryExport(id, body)),
    exportBytes: (id) => unwrap(bridge.exportBytes(id)),
    writePreparedClipboard: async (body) => {
      await unwrap(bridge.writePreparedClipboard(body));
    },
    saveExport: (body) => unwrap(bridge.saveExport(body)),
    readFinalization: () => unwrap(bridge.readFinalization()),
    readReviews: (after) => unwrap(bridge.readReviews(after)),
    reviewCandidate: (id, offset) => unwrap(bridge.reviewCandidate(id, offset)),
    reviewSourceComparison: (id) => unwrap(bridge.reviewSourceComparison(id)),
    reviewMessages: (id, before) => unwrap(bridge.reviewMessages(id, before)),
    readPlanning: () => unwrap(bridge.readPlanning()),
    preparePlanning: (body) => unwrap(bridge.preparePlanning(body)),
    planningTask: (id) => unwrap(bridge.planningTask(id)),
    preparePlanningVisual: (body) => unwrap(bridge.preparePlanningVisual(body)),
    planningVisual: (id) => unwrap(bridge.planningVisual(id)),
    cancelPlanningVisual: (id) => unwrap(bridge.cancelPlanningVisual(id)),
    readAiSettings: () => unwrap(bridge.readAiSettings()),
    updateAiSettings: (update) => unwrap(bridge.updateAiSettings(update)),
    updateAiCredential: (update) => unwrap(bridge.updateAiCredential(update)),
    deleteAiCredential: (update) => unwrap(bridge.deleteAiCredential(update)),
    resolveAiConfiguration: () => unwrap(bridge.resolveAiConfiguration()),
    discoverAiModels: (providerId) =>
      unwrap(bridge.discoverAiModels(providerId)),
    prepareAiTest: (target) => unwrap(bridge.prepareAiTest(target)),
    testAiConnection: (action) => unwrap(bridge.testAiConnection(action)),
    readAiRun: (id) => unwrap(bridge.readAiRun(id)),
    readAiResult: (id) => unwrap(bridge.readAiResult(id)),
    cancelAiRun: (id) => unwrap(bridge.cancelAiRun(id)),
    readSources: (after) => unwrap(bridge.readSources(after)),
    uploadFile: async () => {
      throw new ApiError("INVALID_REQUEST");
    },
    pickFileIntake: async (signal, progress) => {
      const id = crypto.randomUUID();
      const remove = bridge.onFileIntakeProgress(id, (loaded, total) =>
        progress?.(loaded, total),
      );
      const cancel = () => {
        void bridge.cancelFileSelection(id);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) return null;
        return await unwrap(bridge.pickFileIntake(id));
      } finally {
        signal?.removeEventListener("abort", cancel);
        remove();
      }
    },
    cancelIntake: (id) => unwrap(bridge.cancelIntake(id)),
    documentAction: (action) => unwrap(bridge.documentAction(action)),
    documentJob: (id) => unwrap(bridge.documentJob(id)),
    extractionPage: (id, offset = 0) =>
      unwrap(bridge.extractionPage(id, offset)),
    subscribeEvents: (handler, resync) =>
      bridge.subscribeEvents(handler, resync),
    openExternalLink: async (url) => {
      validateExternalLink(url);
      await unwrap(bridge.openExternalLink(url));
    },
    health: () => unwrap(bridge.health()),
    readProject: () => unwrap(bridge.readProject()),
    createProject: (c) => unwrap(bridge.createProject(c)),
    ensureProject: (c) => unwrap(bridge.ensureProject(c)),
    renameProject: (c) => unwrap(bridge.renameProject(c)),
    readHistory: () => unwrap(bridge.readHistory()),
    readManuscript: () => unwrap(bridge.readManuscript()),
    executeManuscript: (c) => unwrap(bridge.executeManuscript(c)),
    commandReceipt: (id) => unwrap(bridge.commandReceipt(id)),
    ...(bridge.readRecentProjects
      ? {
          readRecentProjects: () => unwrap(bridge.readRecentProjects!()),
        }
      : {}),
    ...(bridge.openRecentProject
      ? {
          openRecentProject: async (id: string) => {
            await unwrap(bridge.openRecentProject!(id));
          },
        }
      : {}),
    pickProject: async (recover) => {
      await unwrap(bridge.pickProject(recover));
    },
    backupProject: () => unwrap(bridge.backupProject()),
    onCloseAborted: (handler) => bridge.onCloseAborted(handler),
    onCloseRequested: (handler) => bridge.onCloseRequested(handler),
  };
}
