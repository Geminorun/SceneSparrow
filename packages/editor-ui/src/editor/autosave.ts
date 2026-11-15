import type {
  ManuscriptCommand,
  ManuscriptState,
  NewBlock,
  CommandReceipt,
  HistoryState,
} from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
import { edits } from "./canonical";
export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";
class UncertainCommit extends Error {}
export class Autosave {
  reviewDirty: (() => boolean) | undefined;
  planningAdapter?: {
    flush: (retry?: boolean) => Promise<boolean>;
    identity: () => string;
    dirty: () => boolean;
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
  private firstPending = 0;
  private inFlight: Promise<boolean> | null = null;
  private unresolved: {
    command: ManuscriptCommand;
    blocks: NewBlock[];
  } | null = null;
  private session = crypto.randomUUID();
  private group = crypto.randomUUID();
  private segments: {
    blocks: NewBlock[];
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
    this.segments.push({
      blocks: structuredClone(this.local),
      group: this.group,
      kind: this.groupKind,
    });
  }
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private groupKind: "typing" | "discrete" = "typing";
  private controls: Promise<unknown> = Promise.resolve();
  private controlPending: ManuscriptCommand | null = null;
  private controlVisible: string | null = null;
  get stageTransitionPending() {
    return (
      this.busy &&
      !!this.controlPending &&
      (this.controlPending.type === "StartManualDraft" ||
        (this.controlPending.type === "CommitManuscriptImport" &&
          this.controlPending.payload.mode === "start"))
    );
  }
  get hasUnresolvedBusiness() {
    return (
      !!this.metadataPending ||
      (!!this.controlPending &&
        !["CloseEditGroup", "UndoProject", "RedoProject"].includes(
          this.controlPending.type,
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
    return this.enqueue(() => this.settle());
  }
  private async closeGroup(): Promise<boolean> {
    if (!this.acknowledgedGroup && !this.controlPending) return true;
    return this.control("CloseEditGroup");
  }
  discrete(action: () => unknown) {
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
    return blocked
      ? Promise.resolve(false)
      : this.enqueue(async () => this.drain());
  }
  navigate(direction: "UndoProject" | "RedoProject", apply: () => void) {
    if (this.reviewDirty?.()) {
      this.operationError = { code: "UNSENT_REVIEW", details: undefined };
      this.notify();
      return Promise.resolve(false);
    }
    if (!this.planningAdapter) return this.navigateCore(direction, apply);
    const requestedVisible = JSON.stringify(this.local);
    const intent = this.planningAdapter.identity();
    return this.settlePlanning(intent).then((ok) =>
      ok
        ? this.navigateCore(
            direction,
            apply,
            () => this.planningAdapter?.identity() === intent,
            requestedVisible,
          )
        : false,
    );
  }
  private navigateCore(
    direction: "UndoProject" | "RedoProject",
    apply: () => void,
    validIntent?: () => boolean,
    requestedVisible = JSON.stringify(this.local),
  ) {
    return this.enqueue(async () => {
      if (this.disposed || this.metadataPending) return false;
      if (this.controlPending) {
        const type = this.controlPending.type as
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
      if (JSON.stringify(this.local) !== requestedVisible) {
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
  get exportInputIdentity() {
    return `${this.generation}:${this.compositionGeneration}:${this.canonicalVersion}`;
  }
  prepareInput() {
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
  ) {
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
      if (this.controlPending?.requestId === command.requestId) {
        this.controlPending = null;
        this.controlVisible = null;
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
  cancelReviewCommand(command: ManuscriptCommand) {
    if (
      (command.type !== "CancelReviewTask" &&
        !(command.type === "SetUserLocks" && !command.payload.locked)) ||
      this.disposed ||
      this.controlPending ||
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
    },
  ) {
    const requestedVisible =
      options?.requestedVisible ?? JSON.stringify(this.local);
    return this.enqueue(async () => {
      if (options?.signal?.aborted || this.disposed || this.metadataPending)
        return false;
      if (this.controlPending) {
        const candidate = options?.replayCommand?.();
        if (
          candidate &&
          JSON.stringify(candidate) === JSON.stringify(this.controlPending)
        )
          return this.control("CloseEditGroup");
        await this.control("CloseEditGroup");
        return false;
      }
      if (this.composing || !(await this.settle())) return false;
      if (JSON.stringify(this.local) !== requestedVisible) {
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
        this.controlPending ||
        this.unresolved ||
        this.metadataPending
      )
        return false;
      const generation = this.generation;
      try {
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
    if (this.reviewDirty?.() || this.metadataPending) return false;
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
      if (this.same() && !this.acknowledgedGroup && !this.controlPending)
        return true;
      retry = false;
    }
  }
  private async control(
    type: "UndoProject" | "RedoProject" | "CloseEditGroup",
    override?: ManuscriptCommand,
  ): Promise<boolean> {
    if (this.disposed || this.composing || this.conversionError) return false;
    const command =
      this.controlPending ??
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
    this.controlPending = command;
    const compositionGeneration = this.compositionGeneration;
    const visible = this.controlVisible ?? JSON.stringify(this.local);
    this.controlVisible = visible;
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
        let canonical: ManuscriptState | undefined;
        let sameBody = true;
        if (command.type !== "CloseEditGroup") {
          canonical = await this.client.readManuscript();
          sameBody =
            JSON.stringify(canonical.blocks) ===
              JSON.stringify(this.state.blocks) &&
            canonical.workspaceStage === this.state.workspaceStage;
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
          (JSON.stringify(this.local) !== visible ||
            this.conversionError ||
            (!sameBody &&
              (this.composing ||
                this.compositionGeneration !== compositionGeneration)) ||
            (canonical.workspaceStage !== this.state.workspaceStage &&
              this.reviewDirty?.()))
        )
          throw new ApiError("REVISION_CONFLICT");
        // All awaits are complete. The final visible-input fence and adoption form
        // one synchronous operation; a proven receipt never acknowledges newer input.
        if (canonical) {
          this.state = canonical;
          this.local = canonical.blocks.map(({ revision: _, ...b }) => b);
          if (!sameBody) this.canonicalVersion++;
        }
        if (command.type === "CloseEditGroup") {
          this.acknowledgedGroup = null;
          if (this.group === command.payload.groupId) this.freshGroup();
          for (const segment of this.segments)
            if (segment.group === command.payload.groupId)
              segment.group = this.group;
        } else {
          this.acknowledgedGroup = null;
          this.segments = [];
          this.freshGroup();
        }
        this.error = "";
        this.status = this.same() ? "saved" : "pending";
        this.history = metadata;
        this.controlPending = null;
        this.controlVisible = null;
        if (this.conversionError) {
          this.status = "error";
          this.error = this.conversionError;
          return false;
        }
        return true;
      } catch (error) {
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
          this.controlPending = null;
          this.controlVisible = null;
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
  }
  acknowledgeBusinessRejection() {
    if (
      !this.controlPending &&
      !this.unresolved &&
      this.same() &&
      !this.conversionError &&
      this.status === "error"
    ) {
      this.status = "saved";
      this.error = "";
      this.notify();
    }
    return this.status === "saved";
  }
  private same() {
    const same =
      this.segments.length === 0 &&
      JSON.stringify(this.local) ===
        JSON.stringify(this.state.blocks.map(({ revision: _, ...b }) => b));
    if (same) this.settledGeneration = this.generation;
    return same;
  }
  invalidate(error: string, rawText: string) {
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
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.composing && !this.disposed) void this.boundary();
    }, 750);
    if (this.status === "error" || this.status === "conflict") {
      this.notify();
      return;
    }
    if (!this.firstPending) this.firstPending = Date.now();
    this.status = this.inFlight ? "saving" : "pending";
    this.notify();
    this.schedule();
  }
  composition(active: boolean) {
    if (active) this.compositionGeneration++;
    this.composing = active;
    if (active) clearTimeout(this.timer);
    else this.schedule();
    this.notify();
  }
  private schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    if (
      !this.composing &&
      !this.inFlight &&
      !["error", "conflict"].includes(this.status)
    )
      this.timer = setTimeout(
        () => void this.flush(),
        Math.max(0, Math.min(300, 2000 - (Date.now() - this.firstPending))),
      );
  }
  private async resolve(command: ManuscriptCommand): Promise<CommandReceipt> {
    try {
      return await this.client.executeManuscript(command);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      try {
        return await this.client.commandReceipt(command.requestId);
      } catch (resolution) {
        if (
          resolution instanceof ApiError &&
          resolution.code === "COMMAND_NOT_FOUND"
        )
          return this.client.executeManuscript(command);
        throw new UncertainCommit(
          resolution instanceof Error
            ? resolution.message
            : "SERVICE_UNAVAILABLE",
        );
      }
    }
  }
  async start() {
    return this.enqueue(async () => {
      if (this.inFlight || this.unresolved || this.controlPending) return false;
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
  private async drain(retry = false): Promise<boolean> {
    if (this.metadataPending) return false;
    if (this.disposed) return false;
    clearTimeout(this.timer);
    if (this.composing || this.conversionError) return false;
    if (this.controlPending && !this.inFlight) {
      if (
        !retry ||
        !(await this.control(
          this.controlPending.type as
            "UndoProject" | "RedoProject" | "CloseEditGroup",
        ))
      )
        return false;
    }
    if (this.inFlight) {
      const ok = await this.inFlight;
      return ok ? this.drain() : false;
    }
    if (!retry && ["error", "conflict"].includes(this.status)) return false;
    if (this.status === "conflict") return false;
    if (!this.unresolved) {
      if (this.same()) {
        this.status = "saved";
        this.firstPending = 0;
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
        this.firstPending = 0;
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
              sent.command.type === "StartManualDraft"
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
        this.firstPending = 0;
        if (this.conversionError) {
          this.status = "error";
          this.error = this.conversionError;
          return false;
        }
        this.error = "";
        this.status = this.same() ? "saved" : "pending";
        return true;
      } catch (error) {
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
          this.status = "error";
          this.error = this.conversionError;
        }
        this.notify();
        if (this.status === "pending") {
          this.firstPending = Date.now();
          this.schedule();
        }
      }
    })();
    const ok = await this.inFlight;
    if (this.conversionError) return false;
    return ok && !this.disposed && !this.composing && !this.same()
      ? this.drain()
      : ok;
  }
  reload() {
    return this.enqueue(() => this.reloadSaved());
  }
  private async reloadSaved() {
    if (this.inFlight) return false;
    try {
      const state = await this.client.readManuscript();
      const history = await this.client.readHistory();
      if (history.workingRevision !== state.workingRevision)
        throw new ApiError("REVISION_CONFLICT");
      this.state = state;
      this.history = history;
      this.controlPending = null;
      this.controlVisible = null;
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
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
  }
}
