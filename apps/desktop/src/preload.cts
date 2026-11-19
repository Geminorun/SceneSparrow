import { contextBridge, ipcRenderer } from "electron";

let closeHandler: () => Promise<boolean> = async () => true;
ipcRenderer.on("manuscript:close-request", async (_event, nonce: string) => {
  ipcRenderer.send("manuscript:close-progress", nonce);
  let allowed = false;
  try {
    allowed = await closeHandler();
  } catch {
    allowed = false;
  }
  ipcRenderer.send("manuscript:close-result", nonce, allowed);
});

contextBridge.exposeInMainWorld("sceneSparrow", {
  readNativePackageSave: (body: unknown) =>
    ipcRenderer.invoke("native-package:save-status", body),
  choosePackageIntake: (body: unknown) =>
    ipcRenderer.invoke("native-package:intake", body),
  cancelNativePackageIntake: (body: unknown) =>
    ipcRenderer.invoke("native-package:cancel-intake", body),
  savePackageArchive: (body: unknown) =>
    ipcRenderer.invoke("native-package:save", body),
  readPackageBase: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:readPackageBase", ...args),
  startProjectPackageExport: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:startProjectPackageExport", ...args),
  startWorkCopyPackageExport: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:startWorkCopyPackageExport", ...args),
  readPackageOperation: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:readPackageOperation", ...args),
  controlPackageOperation: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:controlPackageOperation", ...args),
  createPackageIntake: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:createPackageIntake", ...args),
  readPackageIntake: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:readPackageIntake", ...args),
  uploadPackageChunk: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:uploadPackageChunk", ...args),
  controlPackageIntake: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:controlPackageIntake", ...args),
  inspectPackage: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:inspectPackage", ...args),
  readPackageInspection: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:readPackageInspection", ...args),
  issuePackageRestoreTarget: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:issuePackageRestoreTarget", ...args),
  restorePackage: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:restorePackage", ...args),
  returnPackage: (...args: unknown[]) =>
    ipcRenderer.invoke("project-package:returnPackage", ...args),
  inspectLegacyMigration: (...args: unknown[]) =>
    ipcRenderer.invoke("project-transfer:inspectLegacyMigration", ...args),
  issueMigrationTarget: (...args: unknown[]) =>
    ipcRenderer.invoke("project-transfer:issueMigrationTarget", ...args),
  startLegacyMigration: (...args: unknown[]) =>
    ipcRenderer.invoke("project-transfer:startLegacyMigration", ...args),
  readMigrationOperation: (...args: unknown[]) =>
    ipcRenderer.invoke("project-transfer:readMigrationOperation", ...args),
  controlMigration: (...args: unknown[]) =>
    ipcRenderer.invoke("project-transfer:controlMigration", ...args),
  inspectProjectFormat: () => ipcRenderer.invoke("project:format"),
  inspectGraphRecovery: (intent: string) =>
    ipcRenderer.invoke("external-work:inspectGraphRecovery", intent),
  readFileGraph: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readFileGraph", ...args),
  readGraphFiles: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readGraphFiles", ...args),
  registerFileGraph: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:registerFileGraph", ...args),
  createWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:createWorkItem", ...args),
  readWorkItems: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readWorkItems", ...args),
  readWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readWorkItem", ...args),
  inspectWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:inspectWorkItem", ...args),
  acceptWorkCandidate: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:acceptWorkCandidate", ...args),
  discardWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:discardWorkItem", ...args),
  controlWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:controlWorkItem", ...args),
  readWorkOperation: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readWorkOperation", ...args),
  readWorkCandidate: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readWorkCandidate", ...args),
  readWorkChanges: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readWorkChanges", ...args),
  readProductionFileLocks: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readProductionFileLocks", ...args),
  setProductionFileLocks: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:setProductionFileLocks", ...args),
  readGraphRecoveries: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readGraphRecoveries", ...args),
  readGraphRecoveryMembers: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:readGraphRecoveryMembers", ...args),
  downloadWorkCandidateMember: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:downloadWorkCandidateMember", ...args),
  downloadGraphRecoveryMember: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:downloadGraphRecoveryMember", ...args),
  revealWorkItem: (...args: unknown[]) =>
    ipcRenderer.invoke("external-work:revealWorkItem", ...args),
  readAuthoredSourceRecoveryEvidence: (intentHash: string) =>
    ipcRenderer.invoke("manuscript:source-evidence", intentHash),
  readAuthoredSourceRecoveryVersion: (intentHash: string, sourceHash: string) =>
    ipcRenderer.invoke("manuscript:source-evidence-version", {
      intentHash,
      sourceHash,
    }),
  readAuthoredSourceStatus: () =>
    ipcRenderer.invoke("manuscript:source-status"),
  rescanAuthoredSource: () => ipcRenderer.invoke("manuscript:source-rescan"),
  readAuthoredSourceCandidate: (id: string) =>
    ipcRenderer.invoke("manuscript:source-candidate", id),
  resolveAuthoredSource: (body: unknown) =>
    ipcRenderer.invoke("manuscript:source-resolve", body),
  recoverAuthoredSource: (body: unknown) =>
    ipcRenderer.invoke("manuscript:source-recover", body),
  readAuthoredSource: () => ipcRenderer.invoke("manuscript:source-read"),
  saveAuthoredSource: (body: unknown) =>
    ipcRenderer.invoke("manuscript:source-save", body),
  readManuscriptIdentity: () => ipcRenderer.invoke("manuscript:identity"),
  readExports: () => ipcRenderer.invoke("export:list"),
  prepareCopy: (body: unknown) => ipcRenderer.invoke("copy:prepare", body),
  startExport: (body: unknown) => ipcRenderer.invoke("export:start", body),
  exportJob: (id: string) => ipcRenderer.invoke("export:job", id),
  cancelExport: (id: string, body: unknown) =>
    ipcRenderer.invoke("export:cancel", id, body),
  retryExport: (id: string, body: unknown) =>
    ipcRenderer.invoke("export:retry", id, body),
  exportBytes: (id: string) => ipcRenderer.invoke("export:bytes", id),
  writePreparedClipboard: (body: unknown) =>
    ipcRenderer.invoke("export:clipboard", body),
  saveExport: (body: unknown) => ipcRenderer.invoke("export:save", body),
  reviewCandidate: (id: string, offset?: number) =>
    ipcRenderer.invoke("reviews:candidate", id, offset),
  reviewSourceComparison: (id: string) =>
    ipcRenderer.invoke("reviews:comparison", id),
  reviewMessages: (id: string, before?: number) =>
    ipcRenderer.invoke("reviews:messages", id, before),
  readFinalization: () => ipcRenderer.invoke("manuscript:finalization"),
  readReviews: (after?: string) => ipcRenderer.invoke("reviews:read", after),
  readPlanning: () => ipcRenderer.invoke("planning:read"),
  preparePlanning: (body: unknown) =>
    ipcRenderer.invoke("planning:prepare", body),
  planningTask: (id: string) => ipcRenderer.invoke("planning:task", id),
  preparePlanningVisual: (body: unknown) =>
    ipcRenderer.invoke("planning:visual-prepare", body),
  planningVisual: (id: string) => ipcRenderer.invoke("planning:visual", id),
  cancelPlanningVisual: (id: string) =>
    ipcRenderer.invoke("planning:visual-cancel", id),
  readAiSettings: () => ipcRenderer.invoke("ai:settings-read"),
  updateAiSettings: (update: unknown) =>
    ipcRenderer.invoke("ai:settings-update", update),
  updateAiCredential: (update: unknown) =>
    ipcRenderer.invoke("ai:credential-update", update),
  deleteAiCredential: (update: unknown) =>
    ipcRenderer.invoke("ai:credential-delete", update),
  resolveAiConfiguration: () => ipcRenderer.invoke("ai:configuration"),
  discoverAiModels: (providerId: string) =>
    ipcRenderer.invoke("ai:models", { providerId }),
  prepareAiTest: (target: unknown) =>
    ipcRenderer.invoke("ai:test-prepare", target),
  testAiConnection: (action: unknown) => ipcRenderer.invoke("ai:test", action),
  readAiResult: (runId: string) => ipcRenderer.invoke("ai:result", runId),
  readAiRun: (runId: string) => ipcRenderer.invoke("ai:run", runId),
  cancelAiRun: (runId: string) => ipcRenderer.invoke("ai:cancel", runId),
  readSources: (after?: string) => ipcRenderer.invoke("sources:read", after),
  readReferenceDirectory: () => ipcRenderer.invoke("reference-directory:read"),
  pickReferenceDirectory: (id: string) =>
    ipcRenderer.invoke("reference-directory:pick", id),
  refreshReferenceDirectory: (id: string, capabilityId: string) =>
    ipcRenderer.invoke("reference-directory:refresh", id, capabilityId),
  cancelReferenceDirectoryBatch: (id: string) =>
    ipcRenderer.invoke("reference-directory:cancel", id),
  pickFileIntake: (id: string) => ipcRenderer.invoke("intake:pick", id),
  cancelFileSelection: (id: string) =>
    ipcRenderer.invoke("intake:pick-cancel", id),
  onFileIntakeProgress: (
    id: string,
    handler: (loaded: number, total: number) => void,
  ) => {
    const listener = (
      _event: unknown,
      received: string,
      loaded: number,
      total: number,
    ) => {
      if (received === id) handler(loaded, total);
    };
    ipcRenderer.on("intake:progress", listener);
    return () => ipcRenderer.removeListener("intake:progress", listener);
  },
  cancelIntake: (id: string) => ipcRenderer.invoke("intake:cancel", id),
  documentAction: (action: unknown) =>
    ipcRenderer.invoke("document:action", action),
  documentJob: (id: string) => ipcRenderer.invoke("document:job", id),
  extractionPage: (id: string, offset: number) =>
    ipcRenderer.invoke("source:extraction", id, offset),
  openExternalLink: (url: string) =>
    ipcRenderer.invoke("source:open-link", url),
  subscribeEvents: (handler: (event: unknown) => void, resync: () => void) => {
    const nonce = crypto.randomUUID();
    const listener = (
      _event: unknown,
      received: string,
      kind: string,
      data: unknown,
    ) => {
      if (received !== nonce) return;
      if (kind === "resync") resync();
      else if (kind === "event") handler(data);
    };
    ipcRenderer.on("project:event", listener);
    ipcRenderer.send("project:events-start", nonce);
    return () => {
      ipcRenderer.removeListener("project:event", listener);
      ipcRenderer.send("project:events-stop", nonce);
    };
  },
  readHistory: () => ipcRenderer.invoke("manuscript:history"),
  readManuscript: () => ipcRenderer.invoke("manuscript:read"),
  executeManuscript: (command: unknown) =>
    ipcRenderer.invoke("manuscript:command", command),
  commandReceipt: (requestId: string) =>
    ipcRenderer.invoke("manuscript:receipt", requestId),
  pickProject: (recover?: boolean) =>
    ipcRenderer.invoke("project:pick", recover),
  readRecentProjects: () => ipcRenderer.invoke("project:recents"),
  openRecentProject: (id: string) =>
    ipcRenderer.invoke("project:open-recent", id),
  backupProject: () => ipcRenderer.invoke("project:backup"),
  onCloseAborted: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("manuscript:close-aborted", listener);
    return () =>
      ipcRenderer.removeListener("manuscript:close-aborted", listener);
  },
  onCloseRequested: (handler: () => Promise<boolean>) => {
    closeHandler = handler;
    return () => {
      if (closeHandler === handler) closeHandler = async () => true;
    };
  },
  health: () => ipcRenderer.invoke("project:health"),
  readProject: () => ipcRenderer.invoke("project:read"),
  ensureProject: (command: unknown) =>
    ipcRenderer.invoke("project:ensure", command),
  renameProject: (command: unknown) =>
    ipcRenderer.invoke("project:rename", command),
  createProject: (command: unknown) =>
    ipcRenderer.invoke("project:create", command),
});
