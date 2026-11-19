import type {
  AuthoredSourceSnapshot,
  AuthoredSourceStatus,
  AuthoredSourceSaveRequest,
  AuthoredSourceResolveRequest,
  AuthoredSourceCandidate,
} from "@scenesparrow/contracts";
import {
  patchEditorSource,
  rebaseSourceAcknowledgment,
  sourceDifference,
  type RawChange,
} from "@scenesparrow/manuscript-format/editor-source";
import type {
  ManuscriptCommand,
  ManuscriptState,
  NewBlock,
  CommandReceipt,
  HistoryState,
} from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
import { edits } from "../manuscript/canonical";
import {
  applicationPreferences,
  type ApplicationPreferencesStore,
} from "../app-preferences";
import type { SaveStatus } from "./types";
import { CompositionActions } from "./composition-actions";
class UncertainCommit extends Error {}
export class ProjectSession {
  readonly actions = new CompositionActions();
  source: AuthoredSourceSnapshot | null = null;
  sourceStatus: AuthoredSourceStatus | null = null;
  sourceLocal = "";
  sourceBodyHash = "";
  private sourcePending: {
    request: AuthoredSourceSaveRequest | AuthoredSourceResolveRequest;
    sent: string;
    changes: RawChange[][];
    generation: number;
    receipt?: CommandReceipt;
    snapshot?: AuthoredSourceSnapshot;
    uncertain?: boolean;
    receiptAbsent?: boolean;
  } | null = null;
  private deferredSourceAck: {
    sent: string;
    accepted: string;
    changes: RawChange[][];
  } | null = null;
  private sourceListeners = new Set<() => void>();
  subscribeSource(listener: () => void) {
    this.sourceListeners.add(listener);
    return () => {
      this.sourceListeners.delete(listener);
    };
  }
  private sourceChanged() {
    for (const listener of this.sourceListeners) listener();
    this.notify();
  }
  initializeSource(snapshot: AuthoredSourceSnapshot) {
    this.source = snapshot;
    this.sourceLocal = snapshot.source;
  }
  updateSource(changes: readonly RawChange[]) {
    if (!this.source) return;
    const next = patchEditorSource(this.sourceLocal, changes);
    if (this.sourcePending) {
      this.sourcePending.changes.push(next.patches);
      if (this.sourcePending.changes.length > 2000)
        this.sourcePending.changes = sourceDifference(
          this.sourcePending.sent,
          next.raw,
        );
    }
    if (this.deferredSourceAck) {
      this.deferredSourceAck.changes.push(next.patches);
      if (this.deferredSourceAck.changes.length > 2000)
        this.deferredSourceAck.changes = sourceDifference(
          this.deferredSourceAck.sent,
          next.raw,
        );
    }
    this.sourceLocal = next.raw;
    this.update(this.local);
    this.sourceChanged();
  }
  private async refreshSource(replace: boolean) {
    const inputGeneration = this.generation;
    if (
      !this.source ||
      !this.client.readAuthoredSourceStatus ||
      !this.client.readAuthoredSource
    )
      return;
    const status = await this.client.readAuthoredSourceStatus();
    this.sourceStatus = status;
    if (
      status.generation !== this.source.generation ||
      status.acceptedHash !== this.source.acceptedHash
    ) {
      const generation = this.generation;
      const snapshot = await this.client.readAuthoredSource();
      if (
        !replace ||
        generation !== this.generation ||
        inputGeneration !== this.generation ||
        this.composing
      )
        throw new ApiError("SOURCE_ACK_AMBIGUOUS");
      this.source = snapshot;
      this.sourceLocal = snapshot.source;
      this.sourceChanged();
    }
    if (this.client.readManuscriptIdentity)
      this.sourceBodyHash = (
        await this.client.readManuscriptIdentity()
      ).bodyHash;
  }
  private sourceInspection = 0;
  async inspectSource(rescan = false) {
    const inspection = ++this.sourceInspection;
    if (!this.source) return;
    const status = await (rescan
      ? this.client.rescanAuthoredSource?.()
      : this.client.readAuthoredSourceStatus?.());
    if (
      status &&
      !this.disposed &&
      inspection === this.sourceInspection &&
      status.generation >= this.source.generation &&
      status.generation >= (this.sourceStatus?.generation ?? 0)
    ) {
      this.sourceStatus = status;
      this.notify();
      this.schedule();
    }
    return status;
  }
  resolveSource(
    candidate: AuthoredSourceCandidate,
    disposition: "accept" | "discard" | "proposal",
    proposal: string | null,
  ) {
    const generation = this.generation,
      context = this.actions.contextVersion;
    return this.actions.run(
      "source-resolution",
      () =>
        this.enqueue(async () => {
          if (
            !this.source ||
            this.disposed ||
            this.composing ||
            context !== this.actions.contextVersion ||
            generation !== this.generation
          )
            return false;
          if (
            this.sourcePending &&
            !("disposition" in this.sourcePending.request)
          ) {
            this.error = "COMMAND_UNRESOLVED";
            this.notify();
            return false;
          }
          if (!this.sourcePending) {
            const request: AuthoredSourceResolveRequest = {
              requestId: crypto.randomUUID(),
              projectId: this.projectId,
              expectedWorkingRevision: this.state.workingRevision,
              expectedGeneration: this.source.generation,
              expectedHash: this.source.acceptedHash,
              candidateId: candidate.id,
              candidateHash: candidate.liveHash,
              disposition,
              source: proposal,
              group: {
                clientSessionId: this.session,
                groupId: crypto.randomUUID(),
                groupSequence: 1,
                kind: "discrete",
              },
            };
            this.sourcePending = {
              request,
              sent:
                disposition === "proposal"
                  ? proposal!
                  : disposition === "accept"
                    ? (candidate.source ?? "")
                    : this.source.source,
              changes: [],
              generation,
            };
          }
          const owned = this.sourcePending.request;
          const sameChoice =
            "disposition" in owned &&
            owned.candidateId === candidate.id &&
            owned.disposition === disposition &&
            owned.source === proposal;
          const ok = await this.sendSource();
          if (ok) this.freshGroup();
          return ok && sameChoice;
        }),
      () => !this.disposed,
    );
  }
  recoverSource(status: AuthoredSourceStatus, preserve = false) {
    return this.enqueue(async () => {
      if (!status.pendingIntent || !this.client.recoverAuthoredSource)
        return false;
      try {
        const next = await this.client.recoverAuthoredSource({
          projectId: this.projectId,
          intentHash: status.pendingIntent.intentHash,
          requestId: status.pendingIntent.requestId,
          disposition: preserve ? "preserveExternal" : "known",
          ...(preserve && status.observationFingerprint
            ? { observationFingerprint: status.observationFingerprint }
            : {}),
        } as Parameters<
          NonNullable<PlatformClient["recoverAuthoredSource"]>
        >[0]);
        if (
          this.sourceStatus?.pendingIntent &&
          this.sourceStatus.pendingIntent.intentHash !==
            status.pendingIntent.intentHash
        )
          return false;
        if (next.generation < (this.sourceStatus?.generation ?? 0))
          return false;
        this.sourceInspection++;
        this.sourceStatus = next;
        this.status =
          this.sourceLocal === this.source?.source ? "saved" : "pending";
        this.error = "";
        this.notify();
        return true;
      } catch (error) {
        this.sourceFailure(error);
        return false;
      }
    });
  }
  private sourceFailure(error: unknown) {
    this.errorOwner = "manuscript";
    this.error = error instanceof Error ? error.message : "STORAGE_UNAVAILABLE";
    this.status =
      error instanceof ApiError && error.code.startsWith("SOURCE_")
        ? "conflict"
        : "error";
    this.notify();
  }
  saveSourceProposal(proposal: string) {
    return this.actions.run(
      "source-proposal",
      () => {
        const generation = this.generation;
        return this.enqueue(async () => {
          if (
            !this.source ||
            this.sourcePending ||
            this.disposed ||
            this.composing ||
            generation !== this.generation
          )
            return false;
          this.sourceLocal = proposal;
          this.generation++;
          this.segments = [];
          this.status = "pending";
          this.error = "";
          this.freshGroup();
          this.groupKind = "discrete";
          this.sourceChanged();
          return this.drain(true);
        });
      },
      () => !this.disposed,
    );
  }
  get hasUnresolvedSource() {
    return !!this.sourcePending;
  }
  private async sourceReceipt(
    sent: NonNullable<ProjectSession["sourcePending"]>,
  ) {
    try {
      sent.receipt = await this.client.commandReceipt(sent.request.requestId);
      sent.receiptAbsent = false;
      return true;
    } catch (error) {
      sent.receiptAbsent =
        error instanceof ApiError && error.code === "COMMAND_NOT_FOUND";
      if (
        error instanceof ApiError &&
        ![
          "COMMAND_NOT_FOUND",
          "NOT_FOUND",
          "STORAGE_UNAVAILABLE",
          "COMMAND_UNRESOLVED",
        ].includes(error.code)
      ) {
        // The receipt endpoint proved this exact original identity was rejected.
        this.sourcePending = null;
        throw error;
      }
      return false;
    }
  }
  private async sendSource() {
    const sent = this.sourcePending;
    if (!sent || !this.source || !this.client.saveAuthoredSource) return false;
    this.status = "saving";
    this.notify();
    let acknowledged:
      | {
          snapshot: AuthoredSourceSnapshot;
          canonical: ManuscriptState;
          history: HistoryState;
        }
      | undefined;
    try {
      if (!sent.receipt && sent.uncertain) {
        if (!(await this.sourceReceipt(sent))) {
          const status = await this.inspectSource();
          if (status?.pendingIntent?.requestId === sent.request.requestId)
            throw new ApiError("SOURCE_RECOVERY_REQUIRED");
        }
      }
      if (!sent.receipt) {
        try {
          const result =
            "disposition" in sent.request
              ? await this.client.resolveAuthoredSource!(sent.request)
              : await this.client.saveAuthoredSource(sent.request);
          sent.receipt = result.receipt;
          sent.snapshot = result.snapshot;
        } catch (error) {
          sent.uncertain = true;
          if (!(await this.sourceReceipt(sent))) {
            if (
              sent.receiptAbsent &&
              error instanceof ApiError &&
              !["STORAGE_UNAVAILABLE", "COMMAND_UNRESOLVED"].includes(
                error.code,
              )
            ) {
              const status = await this.inspectSource();
              if (status && !status.pendingIntent) this.sourcePending = null;
            }
            throw error;
          }
        }
      }
      let snapshot = sent.snapshot ?? (await this.client.readAuthoredSource!());
      const canonical = await this.client.readManuscript();
      const history = await this.client.readHistory();
      if (this.disposed) return false;
      if (
        canonical.workingRevision > snapshot.workingRevision &&
        this.client.readAuthoredSourceStatus
      ) {
        const status = await this.client.readAuthoredSourceStatus();
        snapshot =
          status.generation !== snapshot.generation ||
          status.acceptedHash !== snapshot.acceptedHash
            ? await this.client.readAuthoredSource!()
            : { ...snapshot, workingRevision: canonical.workingRevision };
      }
      if (
        canonical.workingRevision !== snapshot.workingRevision ||
        history.workingRevision !== canonical.workingRevision
      )
        throw new ApiError("REVISION_CONFLICT");
      acknowledged = { snapshot, canonical, history };
      const retainedSegments = this.segments.filter(
        (segment) => (segment.generation ?? 0) > sent.generation,
      );
      this.segments = retainedSegments;
      const current =
        this.generation === sent.generation
          ? snapshot.source
          : rebaseSourceAcknowledgment(
              sent.sent,
              snapshot.source,
              sent.changes,
              this.sourceLocal,
            );
      const deferred = this.composing && current !== this.sourceLocal;
      if (deferred)
        this.deferredSourceAck = {
          sent: sent.sent,
          accepted: snapshot.source,
          changes: [...sent.changes],
        };
      const mappedSegments = deferred
        ? retainedSegments
        : retainedSegments.map((segment) =>
            segment.source === undefined
              ? segment
              : {
                  ...segment,
                  source: rebaseSourceAcknowledgment(
                    sent.sent,
                    snapshot.source,
                    sourceDifference(sent.sent, segment.source),
                    segment.source,
                  ),
                },
          );
      this.segments = mappedSegments;
      this.sourceInspection++;
      this.source = snapshot;
      if (!deferred) this.sourceLocal = current;
      this.state = canonical;
      this.local = canonical.blocks.map(({ revision: _, ...b }) => b);
      this.history = history;
      this.sourcePending = null;
      this.acknowledgedGroup =
        "disposition" in sent.request
          ? null
          : {
              clientSessionId: sent.request.group.clientSessionId,
              groupId: sent.request.group.groupId,
              groupSequence: sent.request.group.groupSequence,
            };
      this.error = "";
      this.status = this.same() ? "saved" : "pending";
      this.canonicalVersion++;
      this.sourceChanged();
      return true;
    } catch (error) {
      if (acknowledged && !(error instanceof ApiError)) {
        this.source = acknowledged.snapshot;
        this.state = acknowledged.canonical;
        this.history = acknowledged.history;
        this.local = this.state.blocks.map(({ revision: _, ...b }) => b);
        this.sourcePending = null;
        this.sourceChanged();
        error = new ApiError("SOURCE_ACK_AMBIGUOUS");
      }
      this.sourceFailure(error);
      return false;
    } finally {
      if (this.status === "pending") this.schedule();
    }
  }

  sourceProposalDirty: (() => boolean) | undefined;
  reviewDirty: (() => boolean) | undefined;
  revealReviewDraft: (() => void) | undefined;
  reviewInputChanged() {
    if (
      this.operationError?.code === "UNSENT_REVIEW" &&
      !this.reviewDirty?.()
    ) {
      this.operationError = null;
      this.notify();
    }
  }
  planningAdapter?: {
    flush: (retry?: boolean) => Promise<boolean>;
    identity: () => string;
    inputVersion?: () => number;
    refresh?: () => Promise<void>;
    dirty: () => boolean;
    autosave: () => Promise<boolean>;
    busy: () => boolean;
    canAutosave: () => boolean;
  };
  private async settlePlanning(intent: string | undefined, retry = false) {
    if (!this.planningAdapter) return true;
    return (
      (await this.planningAdapter.flush(retry)) &&
      this.planningAdapter?.identity() === intent
    );
  }

  local: NewBlock[];
  status: SaveStatus = "saved";
  error = "";
  errorOwner: "manuscript" | "planning" = "manuscript";
  get failureOwner() {
    return this.unresolved || this.sourcePending || this.conversionError
      ? "manuscript"
      : this.errorOwner;
  }
  operationError: {
    code: string;
    details: import("@scenesparrow/contracts").HistoryErrorDetails | undefined;
  } | null = null;
  businessReceipt: { requestId: string; receipt: CommandReceipt } | undefined;
  businessRejection: { requestId: string; code: string } | undefined;
  businessErrorDetails:
    import("@scenesparrow/contracts").HistoryErrorDetails | undefined;
  composing = false;
  recoveryText: string | null = null;
  private conversionError: string | null = null;
  private disposed = false;
  latest: ManuscriptState | null = null;
  private notify() {
    if (!this.disposed) this.changed();
  }
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstPending: number | null = null;
  private lastInput = 0;
  private backgroundSaving = false;
  private backgroundInputSince: number | null = null;
  private backgroundBodyGeneration: number | undefined;
  private manualSavePending = false;
  private windowSavePending = false;
  private unsubscribePreferences: () => void;
  private inFlight: Promise<boolean> | null = null;
  private unresolved: {
    command: ManuscriptCommand;
    blocks: NewBlock[];
  } | null = null;
  private session = crypto.randomUUID();
  private group = crypto.randomUUID();
  private segments: {
    blocks: NewBlock[];
    source?: string;
    generation?: number;
    group: string;
    kind: "typing" | "discrete";
  }[] = [];
  private sequences = new Map<string, number>();
  private acknowledgedGroup: {
    clientSessionId: string;
    groupId: string;
    groupSequence: number;
  } | null = null;
  private generation = 0;
  private settledGeneration = 0;
  get hasLocalBodyChanges() {
    return this.generation !== this.settledGeneration;
  }
  private compositionGeneration = 0;
  private metadataPending: ManuscriptCommand | null = null;
  private capturedGeneration = -1;
  private capture() {
    if (this.capturedGeneration === this.generation) return;
    this.capturedGeneration = this.generation;
    if (this.same()) return;
    const segment = {
      blocks: structuredClone(this.local),
      ...(this.source
        ? { source: this.sourceLocal, generation: this.generation }
        : {}),
      group: this.group,
      kind: this.groupKind,
    };
    if (this.segments.at(-1)?.group === this.group)
      this.segments[this.segments.length - 1] = segment;
    else this.segments.push(segment);
    this.boundSegments();
  }
  private boundSegments(limit = 6) {
    // The unresolved payload is owned separately and is never evicted.
    if (this.segments.length > limit)
      this.segments.splice(0, this.segments.length - limit);
  }
  get canUndo() {
    return this.hasPendingEdits || this.history.undoCount > 0;
  }
  get canRedo() {
    return !this.hasPendingEdits && this.history.redoCount > 0;
  }
  private get hasPendingEdits() {
    return this.hasLocalBodyChanges || !!this.planningAdapter?.dirty();
  }
  private get hasAutosaveWork() {
    return (
      this.hasLocalBodyChanges ||
      !!(this.planningAdapter?.dirty() && this.planningAdapter.canAutosave())
    );
  }
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private groupKind: "typing" | "discrete" = "typing";
  private controls: Promise<unknown> = Promise.resolve();
  private pendingControl: {
    command: ManuscriptCommand;
    visible: string;
  } | null = null;
  private historyTail: Promise<unknown> = Promise.resolve();
  private historyPending = 0;
  get stageTransitionPending() {
    return (
      this.busy &&
      !!this.pendingControl &&
      (this.pendingControl.command.type === "StartManualDraft" ||
        (this.pendingControl.command.type === "CommitManuscriptImport" &&
          this.pendingControl.command.payload.mode === "start"))
    );
  }
  get hasUnresolvedBusiness() {
    return (
      !!this.metadataPending ||
      (!!this.pendingControl &&
        !["CloseEditGroup", "UndoProject", "RedoProject"].includes(
          this.pendingControl.command.type,
        ))
    );
  }
  history: HistoryState;
  busy = false;
  canonicalVersion = 0;
  acting = false;
  private freshGroup() {
    this.group = crypto.randomUUID();
    this.groupKind = "typing";
  }
  private acceptHistory(receipt: CommandReceipt) {
    this.history = {
      ...this.history,
      workingRevision: receipt.workingRevision,
      historyRevision: receipt.historyRevision,
      cursor: receipt.cursor,
      undoCount: receipt.undoCount,
      redoCount: receipt.redoCount,
      undoLabel: receipt.undoLabel ?? null,
      redoLabel: receipt.redoLabel ?? null,
    };
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = this.controls.then(action);
    this.controls = task.catch(() => {});
    return task;
  }
  boundary() {
    if (this.disposed || this.composing) return Promise.resolve(false);
    clearTimeout(this.idleTimer);
    this.capture();
    this.freshGroup();
    return Promise.resolve(true);
  }
  private async closeGroup(): Promise<boolean> {
    if (!this.acknowledgedGroup && !this.pendingControl) return true;
    return this.control("CloseEditGroup");
  }
  discrete(action: () => unknown): Promise<boolean> {
    if (this.composing)
      return this.actions.run("discrete", () => this.discrete(action));
    if (this.disposed || this.composing) return Promise.resolve(false);
    const blocked =
      !!this.conversionError || ["error", "conflict"].includes(this.status);
    clearTimeout(this.idleTimer);
    if (!this.conversionError) this.capture();
    this.freshGroup();
    this.groupKind = "discrete";
    this.acting = true;
    try {
      action();
    } finally {
      this.acting = false;
    }
    if (!this.conversionError) this.capture();
    this.freshGroup();
    return Promise.resolve(!blocked);
  }
  navigate(
    direction: "UndoProject" | "RedoProject",
    apply: () => void,
  ): Promise<boolean> {
    if (this.composing)
      return this.actions.run("history", () => this.navigate(direction, apply));
    if (this.reviewDirty?.()) {
      this.operationError = { code: "UNSENT_REVIEW", details: undefined };
      this.notify();
      return Promise.resolve(false);
    }
    if (this.historyPending >= 8) return Promise.resolve(false);
    const following = this.historyPending > 0;
    const generation = this.generation,
      composition = this.compositionGeneration;
    const planningInput = this.planningAdapter?.inputVersion?.();
    const context = this.actions.contextVersion;
    const requestedVisible = JSON.stringify(this.local);
    const intent = this.planningAdapter?.identity();
    this.historyPending++;
    const task = this.historyTail
      .then(async () => {
        if (
          this.disposed ||
          this.composing ||
          context !== this.actions.contextVersion ||
          (following &&
            (generation !== this.generation ||
              composition !== this.compositionGeneration ||
              planningInput !== this.planningAdapter?.inputVersion?.()))
        )
          return false;
        // Only preceding history may rebase this gesture; any user input cancels it.
        const visible = following
          ? JSON.stringify(this.local)
          : requestedVisible;
        const planningIntent = following
          ? this.planningAdapter?.identity()
          : intent;
        if (!(await this.settlePlanning(planningIntent))) return false;
        const ok = await this.navigateCore(
          direction,
          apply,
          () =>
            context === this.actions.contextVersion &&
            this.planningAdapter?.identity() === planningIntent,
          visible,
        );
        if (ok) await this.planningAdapter?.refresh?.();
        return ok;
      })
      .finally(() => {
        this.historyPending--;
      });
    this.historyTail = task.catch(() => {});
    return task;
  }
  private navigateCore(
    direction: "UndoProject" | "RedoProject",
    apply: () => void,
    validIntent?: () => boolean,
    requestedVisible = JSON.stringify(this.local),
  ) {
    const requestedGeneration = this.generation;
    return this.enqueue(async () => {
      if (this.disposed || this.metadataPending) return false;
      if (this.pendingControl) {
        const type = this.pendingControl.command.type as
          "UndoProject" | "RedoProject" | "CloseEditGroup";
        const ok = await this.control(type);
        if (ok && type !== "CloseEditGroup" && this.canPresentCanonical)
          apply();
        return ok;
      }
      if (
        this.composing ||
        !(await this.settle()) ||
        (validIntent && !validIntent())
      )
        return false;
      if (
        this.source
          ? requestedGeneration !== this.generation
          : JSON.stringify(this.local) !== requestedVisible
      ) {
        this.error = "REVISION_CONFLICT";
        this.status = "conflict";
        this.latest = this.state;
        this.notify();
        return false;
      }
      if (this.reviewDirty?.()) {
        this.operationError = { code: "UNSENT_REVIEW", details: undefined };
        this.notify();
        return false;
      }
      if (
        (direction === "UndoProject"
          ? this.history.undoCount
          : this.history.redoCount) === 0
      )
        return true;
      const ok = await this.control(direction);
      if (ok && this.canPresentCanonical) apply();
      return ok;
    });
  }
  get canPresentCanonical() {
    return (
      !this.disposed &&
      !this.composing &&
      !this.conversionError &&
      this.status === "saved" &&
      !this.hasLocalBodyChanges
    );
  }
  get visibleInputIdentity() {
    return `${this.generation}:${this.compositionGeneration}`;
  }
  get exportInputIdentity() {
    return `${this.generation}:${this.compositionGeneration}:${this.canonicalVersion}`;
  }
  prepareInput(): Promise<boolean> {
    if (this.source && !this.composing) {
      const generation = this.generation,
        context = this.actions.contextVersion,
        intent = this.planningAdapter?.identity();
      return this.settlePlanning(intent).then((ok) =>
        ok
          ? this.enqueue(async () => {
              if (
                this.disposed ||
                this.composing ||
                generation !== this.generation ||
                context !== this.actions.contextVersion
              )
                return false;
              return (await this.settle()) && generation === this.generation;
            })
          : false,
      );
    }
    if (this.composing)
      return this.actions.run("prepare-input", () => this.prepareInput());
    if (!this.planningAdapter)
      return this.enqueue(async () => (this.composing ? false : this.settle()));
    const intent = this.planningAdapter?.identity();
    return this.settlePlanning(intent).then((ok) =>
      ok
        ? this.enqueue(async () =>
            this.composing || this.planningAdapter?.identity() !== intent
              ? false
              : this.settle(),
          )
        : false,
    );
  }
  business(
    build: (revision: number) => ManuscriptCommand,
    options?: {
      signal?: AbortSignal;
      dispatched?: () => void;
      validIntent?: () => boolean;
      requestedVisible?: string;
    },
  ): Promise<boolean> {
    if (this.composing)
      return this.actions.run(
        "business",
        () => this.business(build, options),
        () =>
          !options?.signal?.aborted &&
          (!options?.validIntent || options.validIntent()),
      );
    if (!this.planningAdapter) return this.businessCore(build, options);
    const requestedVisible =
      options?.requestedVisible ?? JSON.stringify(this.local);
    const intent = this.planningAdapter.identity();
    return this.settlePlanning(intent).then((ok) =>
      ok
        ? this.businessCore(build, {
            ...options,
            requestedVisible,
            validIntent: () =>
              (!options?.validIntent || options.validIntent()) &&
              this.planningAdapter?.identity() === intent,
          })
        : false,
    );
  }
  async reconcileMetadataReceipt(command: ManuscriptCommand) {
    if (
      command.type !== "SetUserLocks" ||
      this.businessReceipt?.requestId !== command.requestId
    )
      return false;
    try {
      const canonical = await this.client.readManuscript();
      if (
        JSON.stringify(canonical.blocks) !==
          JSON.stringify(this.state.blocks) ||
        canonical.workspaceStage !== this.state.workspaceStage
      )
        return false;
      this.state = canonical;
      if (this.pendingControl?.command.requestId === command.requestId) {
        this.pendingControl = null;
      }
      if (!this.conversionError) {
        this.error = "";
        this.status = this.same() ? "saved" : "pending";
      }
      this.notify();
      return true;
    } catch {
      return false;
    }
  }
  cancelOrUnlock(command: ManuscriptCommand) {
    if (
      (command.type !== "CancelReviewTask" &&
        command.type !== "CancelPlanningTask" &&
        !(command.type === "SetUserLocks" && !command.payload.locked)) ||
      this.disposed ||
      this.pendingControl ||
      this.sourcePending ||
      this.unresolved ||
      (this.metadataPending &&
        this.metadataPending.requestId !== command.requestId)
    )
      return Promise.resolve(false);
    this.metadataPending = command;
    return this.enqueue(async () => {
      try {
        const receipt = await this.resolve(command);
        this.businessReceipt = { requestId: command.requestId, receipt };
        this.acceptHistory(receipt);
        this.metadataPending = null;
        try {
          const canonical = await this.client.readManuscript();
          if (
            JSON.stringify(canonical.blocks) ===
              JSON.stringify(this.state.blocks) &&
            canonical.workspaceStage === this.state.workspaceStage
          )
            this.state = canonical;
        } catch {
          /* The proven metadata receipt is final; a later explicit resync can refresh tokens. */
        }
        this.notify();
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.code !== "STORAGE_UNAVAILABLE") {
          this.businessRejection = {
            requestId: command.requestId,
            code: error.code,
          };
          this.metadataPending = null;
        }
        this.notify();
        return false;
      }
    });
  }
  businessCore(
    build: (revision: number) => ManuscriptCommand,
    options?: {
      signal?: AbortSignal;
      dispatched?: () => void;
      validIntent?: () => boolean;
      replayCommand?: () => ManuscriptCommand | null;
      requestedVisible?: string;
      bodyPreserving?: boolean;
      background?: boolean;
    },
  ) {
    const requestedVisible =
      options?.requestedVisible ?? JSON.stringify(this.local);
    const requestedGeneration = this.generation;
    return this.enqueue(async () => {
      if (options?.signal?.aborted || this.disposed || this.metadataPending)
        return false;
      if (this.pendingControl) {
        const candidate = options?.replayCommand?.();
        if (
          candidate &&
          JSON.stringify(candidate) ===
            JSON.stringify(this.pendingControl.command)
        )
          return this.control("CloseEditGroup");
        await this.control("CloseEditGroup");
        return false;
      }
      if (
        this.composing ||
        !(await (options?.background
          ? this.drain(false, this.backgroundBodyGeneration)
          : this.settle()))
      )
        return false;
      if (
        !options?.bodyPreserving &&
        (this.source
          ? requestedGeneration !== this.generation
          : JSON.stringify(this.local) !== requestedVisible)
      ) {
        this.error = "REVISION_CONFLICT";
        this.status = "conflict";
        this.notify();
        return false;
      }
      if (
        options?.signal?.aborted ||
        this.disposed ||
        (options?.validIntent && !options.validIntent())
      )
        return false;
      const command = build(this.state.workingRevision);
      options?.dispatched?.();
      return this.control("CloseEditGroup", command);
    });
  }
  resync() {
    return this.enqueue(async () => {
      if (
        this.disposed ||
        this.pendingControl ||
        this.unresolved ||
        this.metadataPending
      )
        return false;
      const generation = this.generation;
      try {
        if (this.source) {
          const identity = await this.client.readManuscriptIdentity!();
          await this.inspectSource();
          if (
            identity.bodyHash === this.sourceBodyHash &&
            identity.workingRevision === this.state.workingRevision
          )
            return true;
          await this.refreshSource(
            this.sourceLocal === this.source.source &&
              generation === this.generation,
          );
          const current = await this.client.readManuscript();
          const history = await this.client.readHistory();
          if (
            generation !== this.generation ||
            this.composing ||
            history.workingRevision !== current.workingRevision
          )
            return false;
          this.state = current;
          this.local = current.blocks.map(({ revision: _, ...b }) => b);
          this.history = history;
          this.canonicalVersion++;
          this.notify();
          return true;
        }
        if (this.client.readManuscriptIdentity) {
          const identity = await this.client.readManuscriptIdentity();
          if (
            this.disposed ||
            identity.workingRevision < this.state.workingRevision
          )
            return false;
          const token = `canonical-1|${this.state.manuscriptId}|${this.state.schemaVersion}|${this.state.blocks.map((b) => `${b.id}:${b.revision}`).join("|")}`;
          const bodyHash = [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(token),
              ),
            ),
          ]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("");
          if (
            identity.bodyHash === bodyHash &&
            identity.workspaceStage === this.state.workspaceStage
          ) {
            const history = await this.client.readHistory();
            if (
              this.disposed ||
              history.workingRevision !== identity.workingRevision ||
              generation !== this.generation
            )
              return false;
            this.state = {
              ...this.state,
              workingRevision: identity.workingRevision,
            };
            this.history = history;
            this.notify();
            return true;
          }
        }
        const current = await this.client.readManuscript();
        if (
          this.disposed ||
          current.workingRevision < this.state.workingRevision
        )
          return false;
        const history = await this.client.readHistory();
        if (
          this.disposed ||
          history.workingRevision !== current.workingRevision
        )
          return false;
        if (current.workingRevision === this.state.workingRevision) {
          this.history = history;
          this.notify();
          return true;
        }
        if (
          generation !== this.generation ||
          !this.same() ||
          this.planningAdapter?.dirty() ||
          (current.workspaceStage !== this.state.workspaceStage &&
            this.reviewDirty?.()) ||
          this.conversionError ||
          this.composing
        ) {
          this.latest = current;
          this.status = this.conversionError ? "error" : "conflict";
          this.error = this.conversionError ?? "REVISION_CONFLICT";
          this.notify();
          return false;
        }
        this.state = current;
        this.local = current.blocks.map(({ revision: _, ...b }) => b);
        this.history = history;
        this.canonicalVersion++;
        this.notify();
        return true;
      } catch {
        return false;
      }
    });
  }
  async controlledClose(retry = false): Promise<boolean> {
    if (
      this.reviewDirty?.() ||
      this.sourceProposalDirty?.() ||
      this.metadataPending
    )
      return false;
    clearTimeout(this.idleTimer);
    for (;;) {
      const intent = this.planningAdapter?.identity();
      if (!(await this.settlePlanning(intent, retry))) {
        if (this.planningAdapter?.identity() !== intent && !this.composing)
          continue;
        return false;
      }
      const result = await this.enqueue(async () => {
        if (this.planningAdapter?.identity() !== intent) return null;
        if (!(await this.settle(retry))) return false;
        return this.planningAdapter?.identity() !== intent ||
          this.planningAdapter?.dirty()
          ? null
          : true;
      });
      if (result !== null)
        return (
          result &&
          !this.reviewDirty?.() &&
          !this.metadataPending &&
          !this.composing
        );
    }
  }
  private async settle(retry = false): Promise<boolean> {
    for (;;) {
      if (!(await this.drain(retry)) || !(await this.closeGroup()))
        return false;
      if (this.disposed || this.composing || this.conversionError) return false;
      if (this.same() && !this.acknowledgedGroup && !this.pendingControl)
        return true;
      if (this.source && !this.same()) return false;
      retry = false;
    }
  }
  private async control(
    type: "UndoProject" | "RedoProject" | "CloseEditGroup",
    override?: ManuscriptCommand,
  ): Promise<boolean> {
    if (this.disposed || this.composing || this.conversionError) return false;
    const command =
      this.pendingControl?.command ??
      override ??
      ({
        type,
        requestId: crypto.randomUUID(),
        projectId: this.projectId,
        expectedWorkingRevision: this.state.workingRevision,
        expectedHistoryRevision: this.history.historyRevision,
        expectedCursor: this.history.cursor,
        payload: type === "CloseEditGroup" ? this.acknowledgedGroup! : {},
      } as ManuscriptCommand);
    this.pendingControl ??= { command, visible: JSON.stringify(this.local) };
    const { visible } = this.pendingControl;
    const compositionGeneration = this.compositionGeneration;
    const sourceGeneration = this.generation;
    this.businessRejection = undefined;
    this.operationError = null;
    this.busy = true;
    this.notify();
    const task = (async () => {
      let proven = false;
      try {
        const receipt = await this.resolve(command);
        proven = true;
        this.businessReceipt = { requestId: command.requestId, receipt };
        this.acceptHistory(receipt);
        const reviewControl = [
          "SetUserLocks",
          "SaveReview",
          "SetReviewHandled",
          "DeleteReviewThread",
          "DiscardReviewCandidate",
          "AcceptReviewCandidates",
          "StartReviewTask",
          "CancelReviewTask",
        ].includes(command.type);
        const taskControl = [
          "StartPlanningTask",
          "CancelPlanningTask",
          "StartReviewTask",
          "CancelReviewTask",
        ].includes(command.type);
        let planningControl = false;
        let canonical: ManuscriptState | undefined;
        let sameBody = true;
        if (command.type !== "CloseEditGroup") {
          canonical = await this.client.readManuscript();
          sameBody =
            JSON.stringify(canonical.blocks) ===
              JSON.stringify(this.state.blocks) &&
            canonical.workspaceStage === this.state.workspaceStage;
          planningControl =
            sameBody &&
            [
              "SavePlanning",
              "StartPlanningTask",
              "CancelPlanningTask",
              "UsePlanningResult",
            ].includes(command.type);
          if (command.type === "SavePlanning" && !sameBody)
            throw new ApiError("REVISION_CONFLICT");
          if (
            (!taskControl &&
              !reviewControl &&
              canonical.workingRevision !== receipt.workingRevision) ||
            (reviewControl &&
              canonical.workingRevision < receipt.workingRevision)
          )
            throw new ApiError("REVISION_CONFLICT");
        }
        // Do not publish canonical state/version while a later metadata read can
        // still allow private typing or IME to arrive against the visible old body.
        const metadata = await this.client.readHistory();
        if (
          metadata.workingRevision !==
            (canonical ?? this.state).workingRevision ||
          (!taskControl &&
            !reviewControl &&
            metadata.historyRevision !== receipt.historyRevision)
        )
          throw new ApiError("HISTORY_CONFLICT");
        if (
          canonical &&
          ((!planningControl &&
            (this.source
              ? sourceGeneration !== this.generation
              : JSON.stringify(this.local) !== visible)) ||
            (!planningControl && this.conversionError) ||
            (!sameBody &&
              (this.composing ||
                this.compositionGeneration !== compositionGeneration)) ||
            (canonical.workspaceStage !== this.state.workspaceStage &&
              this.reviewDirty?.()))
        )
          throw new ApiError("REVISION_CONFLICT");
        if (this.source && command.type !== "CloseEditGroup")
          await this.refreshSource(
            sourceGeneration === this.generation && !this.hasLocalBodyChanges,
          );
        // All awaits are complete. The final visible-input fence and adoption form
        // one synchronous operation; a proven receipt never acknowledges newer input.
        if (canonical) {
          this.state = canonical;
          if (!planningControl)
            this.local = canonical.blocks.map(({ revision: _, ...b }) => b);
          if (!sameBody) this.canonicalVersion++;
        }
        if (command.type === "CloseEditGroup") {
          this.acknowledgedGroup = null;
          if (this.group === command.payload.groupId) this.freshGroup();
          for (const segment of this.segments)
            if (segment.group === command.payload.groupId)
              segment.group = this.group;
        } else if (!planningControl) {
          this.acknowledgedGroup = null;
          this.segments = [];
          this.freshGroup();
        }
        this.error = "";
        this.status = this.same() ? "saved" : "pending";
        this.history = metadata;
        this.pendingControl = null;
        if (this.conversionError) {
          this.status = "error";
          this.error = this.conversionError;
          return false;
        }
        return true;
      } catch (error) {
        this.errorOwner = [
          "SavePlanning",
          "StartPlanningTask",
          "CancelPlanningTask",
          "UsePlanningResult",
        ].includes(command.type)
          ? "planning"
          : "manuscript";
        this.businessErrorDetails =
          error instanceof ApiError ? error.details : undefined;
        this.error =
          error instanceof Error ? error.message : "STORAGE_UNAVAILABLE";
        this.status =
          error instanceof ApiError &&
          ["REVISION_CONFLICT", "HISTORY_CONFLICT", "IMPORT_STALE"].includes(
            error.code,
          )
            ? "conflict"
            : "error";
        if (
          !proven &&
          error instanceof ApiError &&
          error.code !== "STORAGE_UNAVAILABLE"
        ) {
          this.businessRejection = {
            requestId: command.requestId,
            code: error.code,
          };
          this.pendingControl = null;
        }
        if (
          !proven &&
          error instanceof ApiError &&
          error.code === "HISTORY_BLOCKED" &&
          ["UndoProject", "RedoProject"].includes(command.type) &&
          !this.unresolved &&
          !this.conversionError &&
          this.same()
        ) {
          this.operationError = { code: error.code, details: error.details };
          this.status = "saved";
          this.error = "";
        }
        if (this.status === "conflict") {
          try {
            this.latest = await this.client.readManuscript();
          } catch {
            /* Recovery remains available. */
          }
        }
        return false;
      } finally {
        this.inFlight = null;
        this.busy = false;
        if (this.conversionError) {
          this.status = "error";
          this.error = this.conversionError;
        }
        this.notify();
        if (this.status === "pending") this.schedule();
      }
    })();
    this.inFlight = task;
    return task;
  }
  constructor(
    public state: ManuscriptState,
    private projectId: string,
    private client: PlatformClient,
    private changed: () => void,
    history?: HistoryState,
    private preferences: ApplicationPreferencesStore = applicationPreferences,
  ) {
    this.history = history ?? {
      workingRevision: state.workingRevision,
      historyRevision: 0,
      cursor: 0,
      undoCount: 0,
      redoCount: 0,
      undoLabel: null,
      redoLabel: null,
    };
    this.local = state.blocks.map(({ revision: _, ...b }) => b);
    this.unsubscribePreferences = preferences.subscribe(() => this.schedule());
  }
  acknowledgeBusinessRejection(preserveLocal = false) {
    if (
      !this.pendingControl &&
      !this.unresolved &&
      (preserveLocal || this.same()) &&
      !this.conversionError &&
      this.status === "error"
    ) {
      this.status = this.same() ? "saved" : "pending";
      this.error = "";
      this.notify();
      if (this.status === "pending") this.schedule();
    }
    return (
      this.status === "saved" || (preserveLocal && this.status === "pending")
    );
  }
  get localBodyMatchesCanonical() {
    if (this.source)
      return this.sourceLocal === this.source.source && !this.deferredSourceAck;
    return (
      JSON.stringify(this.local) ===
      JSON.stringify(this.state.blocks.map(({ revision: _, ...b }) => b))
    );
  }
  private same() {
    const same =
      this.segments.length === 0 &&
      (this.source
        ? this.sourceLocal === this.source.source
        : this.localBodyMatchesCanonical);
    if (same) this.settledGeneration = this.generation;
    return same;
  }
  invalidate(error: string, rawText: string) {
    this.errorOwner = "manuscript";
    clearTimeout(this.timer);
    this.conversionError = error;
    this.recoveryText = rawText;
    this.status = "error";
    this.error = error;
    this.notify();
  }
  update(blocks: NewBlock[]) {
    this.conversionError = null;
    this.recoveryText = null;
    this.local = blocks;
    this.generation++;
    this.boundSegments(5);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.composing && !this.disposed) void this.boundary();
    }, 750);
    if (
      this.errorOwner === "planning" &&
      !this.pendingControl &&
      !this.metadataPending &&
      !this.unresolved
    )
      this.acknowledgeBusinessRejection(true);
    if (this.status === "error" || this.status === "conflict") {
      this.notify();
      return;
    }
    this.status = this.inFlight ? "saving" : "pending";
    this.inputActivity();
  }
  composition(active: boolean, source = "manuscript") {
    if (active) this.compositionGeneration++;
    this.actions.composition(source, active);
    this.composing = this.actions.composing;
    if (this.composing) clearTimeout(this.timer);
    else {
      if (this.deferredSourceAck) {
        const ack = this.deferredSourceAck;
        try {
          const current = rebaseSourceAcknowledgment(
            ack.sent,
            ack.accepted,
            ack.changes,
            this.sourceLocal,
          );
          const mappedSegments = this.segments.map((segment) =>
            segment.source === undefined
              ? segment
              : {
                  ...segment,
                  source: rebaseSourceAcknowledgment(
                    ack.sent,
                    ack.accepted,
                    sourceDifference(ack.sent, segment.source),
                    segment.source,
                  ),
                },
          );
          this.segments = mappedSegments;
          this.sourceLocal = current;
          this.deferredSourceAck = null;
          this.status = this.same() ? "saved" : "pending";
          this.sourceChanged();
        } catch (error) {
          this.sourceFailure(error);
        }
      } else if (this.source) this.sourceChanged();
      this.schedule();
      if (this.manualSavePending) {
        this.manualSavePending = false;
        queueMicrotask(() => {
          if (!this.disposed) void this.manualSave();
        });
      } else if (this.windowSavePending) {
        this.windowSavePending = false;
        queueMicrotask(() => {
          if (!this.disposed) void this.windowChanged();
        });
      }
    }
    this.notify();
  }
  manualSave() {
    if (this.composing) {
      this.manualSavePending = true;
      return Promise.resolve(false);
    }
    return this.prepareInput();
  }
  private schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    if (
      !this.composing &&
      (!this.source ||
        !this.sourceStatus ||
        this.sourceStatus.externalStatus === "unchanged") &&
      !this.inFlight &&
      !this.backgroundSaving &&
      !this.planningAdapter?.busy() &&
      this.preferences.getSnapshot().saveMode === "after_delay" &&
      this.hasAutosaveWork &&
      !["error", "conflict"].includes(this.status)
    ) {
      const now = Date.now();
      this.firstPending ??= now;
      this.timer = setTimeout(
        () => void this.autosave(),
        Math.max(
          0,
          Math.min(
            this.preferences.getSnapshot().saveDelaySeconds * 1000 -
              (now - this.lastInput),
            60_000 - (now - this.firstPending),
          ),
        ),
      );
    }
  }
  inputActivity() {
    const now = Date.now();
    if (this.backgroundSaving) this.backgroundInputSince ??= now;
    this.firstPending ??= now;
    this.lastInput = now;
    this.notify();
    this.schedule();
  }
  settlementChanged() {
    if (!this.hasAutosaveWork) this.firstPending = null;
    this.notify();
    this.schedule();
  }
  windowChanged() {
    if (this.preferences.getSnapshot().saveMode === "on_window_change") {
      if (this.composing) {
        this.windowSavePending = true;
        return Promise.resolve(false);
      }
      return this.autosave();
    }
    return Promise.resolve(true);
  }
  private async autosave() {
    if (this.composing || this.disposed || this.backgroundSaving) return false;
    this.backgroundSaving = true;
    this.backgroundInputSince = null;
    this.backgroundBodyGeneration = this.generation;
    const planningIntent = this.planningAdapter?.identity();
    clearTimeout(this.timer);
    try {
      const bodySaved = await this.enqueue(async () => {
        if (!(await this.drain(false, this.backgroundBodyGeneration)))
          return false;
        // Only a local history boundary closes a typing group; a timer alone does not.
        if (
          this.acknowledgedGroup &&
          this.acknowledgedGroup.groupId !== this.group
        )
          return this.closeGroup();
        return true;
      });
      if (!bodySaved) return false;
      if (
        this.planningAdapter?.identity() === planningIntent &&
        this.planningAdapter?.canAutosave()
      )
        return await this.planningAdapter.autosave();
      return true;
    } finally {
      this.backgroundSaving = false;
      this.backgroundBodyGeneration = undefined;
      if (this.backgroundInputSince !== null)
        this.firstPending = this.backgroundInputSince;
      this.settlementChanged();
    }
  }
  private readonly pendingReceipts = new Set<string>();
  private async resolve(command: ManuscriptCommand): Promise<CommandReceipt> {
    let submissions = 0;
    const resolveReceipt = async (): Promise<CommandReceipt> => {
      try {
        const receipt = await this.client.commandReceipt(command.requestId);
        this.pendingReceipts.delete(command.requestId);
        return receipt;
      } catch (resolution) {
        if (
          resolution instanceof ApiError &&
          resolution.code === "COMMAND_NOT_FOUND"
        ) {
          this.pendingReceipts.delete(command.requestId);
          if (submissions < 2) return submit();
          if (!this.disposed) this.pendingReceipts.add(command.requestId);
        }
        throw new UncertainCommit(
          resolution instanceof Error
            ? resolution.message
            : "SERVICE_UNAVAILABLE",
        );
      }
    };
    const submit = async (): Promise<CommandReceipt> => {
      submissions++;
      try {
        const receipt = await this.client.executeManuscript(command);
        this.pendingReceipts.delete(command.requestId);
        return receipt;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (!this.disposed) this.pendingReceipts.add(command.requestId);
        // Only a receipt for this exact identity can establish a committed result.
        return resolveReceipt();
      }
    };
    return this.pendingReceipts.has(command.requestId)
      ? resolveReceipt()
      : submit();
  }
  async start() {
    return this.enqueue(async () => {
      if (this.inFlight || this.unresolved || this.pendingControl) return false;
      const command: ManuscriptCommand = {
        type: "StartManualDraft",
        requestId: crypto.randomUUID(),
        projectId: this.projectId,
        expectedWorkingRevision: this.state.workingRevision,
        payload: {},
      };
      this.unresolved = { command, blocks: [] };
      return this.drain(true);
    });
  }
  flush(retry = false): Promise<boolean> {
    if (this.disposed || this.composing || this.conversionError)
      return Promise.resolve(false);
    return this.enqueue(() => this.drain(retry));
  }
  private async drain(
    retry = false,
    backgroundGeneration?: number,
  ): Promise<boolean> {
    if (this.source) {
      const targetGeneration = backgroundGeneration ?? this.generation;
      if (
        this.disposed ||
        this.composing ||
        this.metadataPending ||
        this.conversionError
      )
        return false;
      if (!retry && ["error", "conflict"].includes(this.status)) return false;
      if (
        backgroundGeneration !== undefined &&
        backgroundGeneration !== this.generation
      )
        return true;
      while (this.segments[0]?.source === this.source.source)
        this.segments.shift();
      const resolvingOriginal = !!this.sourcePending;
      while (this.sourcePending || !this.same()) {
        const previousGeneration = this.sourcePending?.generation;
        if (!this.sourcePending) {
          const segment = this.segments.shift();
          const group = segment?.group ?? this.group;
          if (
            this.acknowledgedGroup &&
            this.acknowledgedGroup.groupId !== group &&
            !(await this.closeGroup())
          )
            return false;
          const request: AuthoredSourceSaveRequest = {
            requestId: crypto.randomUUID(),
            projectId: this.projectId,
            expectedWorkingRevision: this.state.workingRevision,
            expectedGeneration: this.source.generation,
            expectedHash: this.source.acceptedHash,
            source: segment?.source ?? this.sourceLocal,
            group: {
              clientSessionId: this.session,
              groupId: group,
              groupSequence: (this.sequences.get(group) ?? 0) + 1,
              kind: segment?.kind ?? this.groupKind,
            },
          };
          this.sequences.set(group, request.group.groupSequence);
          this.sourcePending = {
            request,
            sent: request.source,
            changes: sourceDifference(request.source, this.sourceLocal),
            generation: segment?.generation ?? this.generation,
          };
        }
        if (!(await this.sendSource())) return false;
        if (
          targetGeneration !== this.generation ||
          (resolvingOriginal && previousGeneration !== this.generation)
        )
          return true;
      }
      this.status = "saved";
      this.error = "";
      if (!this.planningAdapter?.dirty()) this.firstPending = null;
      this.notify();
      return true;
    }
    if (this.metadataPending) return false;
    if (this.disposed) return false;
    clearTimeout(this.timer);
    if (this.composing || this.conversionError) return false;
    if (this.pendingControl && !this.inFlight) {
      if (
        !retry ||
        !(await this.control(
          this.pendingControl.command.type as
            "UndoProject" | "RedoProject" | "CloseEditGroup",
        ))
      )
        return false;
    }
    if (this.inFlight) {
      const ok = await this.inFlight;
      return ok ? this.drain(false, backgroundGeneration) : false;
    }
    if (!retry && ["error", "conflict"].includes(this.status)) return false;
    if (this.status === "conflict") return false;
    if (
      backgroundGeneration !== undefined &&
      backgroundGeneration !== this.generation
    )
      return true;
    if (!this.unresolved) {
      if (this.same()) {
        this.status = "saved";
        if (!this.planningAdapter?.dirty()) this.firstPending = null;
        this.notify();
        return true;
      }
      while (
        this.segments.length &&
        JSON.stringify(this.segments[0]!.blocks) ===
          JSON.stringify(this.state.blocks.map(({ revision: _, ...b }) => b))
      )
        this.segments.shift();
      if (this.same()) {
        this.status = "saved";
        if (!this.planningAdapter?.dirty()) this.firstPending = null;
        this.notify();
        return true;
      }
      const segment = this.segments.shift() ?? {
        blocks: structuredClone(this.local),
        group: this.group,
        kind: this.groupKind,
      };
      if (
        this.acknowledgedGroup &&
        this.acknowledgedGroup.groupId !== segment.group
      ) {
        if (!(await this.closeGroup())) {
          this.segments.unshift(segment);
          return false;
        }
        if (this.disposed || this.conversionError || this.composing) {
          this.segments.unshift(segment);
          return false;
        }
      }
      let payload;
      try {
        payload = edits(this.state.blocks, segment.blocks);
      } catch (error) {
        this.errorOwner = "manuscript";
        this.status = "error";
        this.error =
          error instanceof Error ? error.message : "DOCUMENT_INVALID";
        this.notify();
        return false;
      }
      const command: ManuscriptCommand = {
        type: "ApplyDocumentEdit",
        requestId: crypto.randomUUID(),
        projectId: this.projectId,
        expectedWorkingRevision: this.state.workingRevision,
        payload: {
          ...payload,
          group: {
            clientSessionId: this.session,
            groupId: segment.group,
            groupSequence: (this.sequences.get(segment.group) ?? 0) + 1,
            kind: segment.kind,
          },
        },
      };
      this.sequences.set(segment.group, command.payload.group.groupSequence);
      this.unresolved = { command, blocks: segment.blocks };
    }
    const sent = this.unresolved;
    this.status = "saving";
    this.notify();
    this.inFlight = (async () => {
      try {
        // A retry always resolves/replays the original identity before any newer edit.
        const receipt = await this.resolve(sent.command);
        this.acceptHistory(receipt);
        if (sent.command.type === "ApplyDocumentEdit")
          this.acknowledgedGroup = {
            clientSessionId: sent.command.payload.group.clientSessionId,
            groupId: sent.command.payload.group.groupId,
            groupSequence: sent.command.payload.group.groupSequence,
          };
        if (receipt.normalized) {
          const canonical = await this.client.readManuscript();
          if (canonical.workingRevision !== receipt.workingRevision)
            throw new ApiError("REVISION_CONFLICT");
          if (JSON.stringify(this.local) !== JSON.stringify(sent.blocks))
            throw new ApiError("REVISION_CONFLICT");
          this.state = canonical;
          if (!this.conversionError)
            this.local = canonical.blocks.map(({ revision: _, ...b }) => b);
        } else {
          const acknowledgedRevisions = new Map(
            receipt.blockRevisions.map((r) => [r.id, r.revision]),
          );
          const previousRevisions = new Map(
            this.state.blocks.map((b) => [b.id, b.revision]),
          );
          this.state = {
            ...this.state,
            workspaceStage:
              sent.command.type === "StartManualDraft" ||
              (sent.command.type === "ApplyDocumentEdit" &&
                sent.blocks.length > 0)
                ? "draft"
                : this.state.workspaceStage,
            workingRevision: receipt.workingRevision,
            blocks: sent.blocks.map((b) => ({
              ...b,
              revision:
                acknowledgedRevisions.get(b.id) ??
                previousRevisions.get(b.id) ??
                1,
            })),
          };
        }
        this.unresolved = null;
        if (this.same() && !this.planningAdapter?.dirty())
          this.firstPending = null;
        if (this.conversionError) {
          this.errorOwner = "manuscript";
          this.status = "error";
          this.error = this.conversionError;
          return false;
        }
        this.error = "";
        this.status = this.same() ? "saved" : "pending";
        return true;
      } catch (error) {
        this.errorOwner = "manuscript";
        this.error =
          error instanceof Error ? error.message : "STORAGE_UNAVAILABLE";
        this.status =
          error instanceof ApiError && error.code === "REVISION_CONFLICT"
            ? "conflict"
            : "error";
        if (this.status === "conflict") {
          try {
            this.latest = await this.client.readManuscript();
          } catch {
            /* Recovery remains available when the service returns. */
          }
        }
        // Known rejections are durable receipts; explicit retry gets a new identity.
        if (error instanceof ApiError && error.code !== "STORAGE_UNAVAILABLE") {
          this.unresolved = null;
          if (sent.command.type === "ApplyDocumentEdit") {
            this.segments = [];
            this.acknowledgedGroup = null;
            this.freshGroup();
          }
        }
        return false;
      } finally {
        this.inFlight = null;
        // An older transport outcome cannot acknowledge unconvertible visible input.
        if (this.conversionError) {
          this.errorOwner = "manuscript";
          this.status = "error";
          this.error = this.conversionError;
        }
        this.notify();
        if (this.status === "pending") {
          this.schedule();
        }
      }
    })();
    const ok = await this.inFlight;
    if (this.conversionError) return false;
    return ok && !this.disposed && !this.composing && !this.same()
      ? this.drain(false, backgroundGeneration)
      : ok;
  }
  reload() {
    return this.enqueue(() => this.reloadSaved());
  }
  private async reloadSaved() {
    // A read cannot prove that an ambiguous command will never commit later.
    // Keep its original identity and local buffer until Retry resolves it.
    if (
      this.inFlight ||
      this.sourcePending ||
      this.unresolved ||
      this.pendingControl ||
      this.metadataPending
    ) {
      this.error = "COMMAND_UNRESOLVED";
      this.notify();
      return false;
    }
    try {
      if (this.source && this.client.readAuthoredSource) {
        const generation = this.generation;
        const snapshot = await this.client.readAuthoredSource();
        const state = await this.client.readManuscript(),
          history = await this.client.readHistory();
        if (
          this.disposed ||
          this.composing ||
          generation !== this.generation ||
          snapshot.workingRevision !== state.workingRevision ||
          history.workingRevision !== state.workingRevision
        )
          return false;
        this.source = snapshot;
        this.sourceLocal = snapshot.source;
        this.state = state;
        this.history = history;
        this.local = state.blocks.map(({ revision: _, ...b }) => b);
        this.segments = [];
        this.deferredSourceAck = null;
        this.acknowledgedGroup = null;
        this.freshGroup();
        this.generation++;
        this.settledGeneration = this.generation;
        this.canonicalVersion++;
        this.error = "";
        this.status = "saved";
        this.sourceChanged();
        return true;
      }
      const capturedGeneration = this.generation;
      await this.refreshSource(true);
      if (capturedGeneration !== this.generation || this.composing)
        return false;
      const state = await this.client.readManuscript();
      const history = await this.client.readHistory();
      if (history.workingRevision !== state.workingRevision)
        throw new ApiError("REVISION_CONFLICT");
      this.state = state;
      this.history = history;
      this.pendingControl = null;
      this.local = this.state.blocks.map(({ revision: _, ...b }) => b);
      this.unresolved = null;
      this.segments = [];
      this.acknowledgedGroup = null;
      this.group = crypto.randomUUID();
      this.conversionError = null;
      this.recoveryText = null;
      this.status = "saved";
      this.settledGeneration = this.generation;
      this.error = "";
      this.notify();
      return true;
    } catch {
      this.error = "STORAGE_UNAVAILABLE";
      this.notify();
      return false;
    }
  }
  dispose() {
    this.actions.dispose();
    this.disposed = true;
    this.unsubscribePreferences();
    this.pendingReceipts.clear();
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
  }
}
