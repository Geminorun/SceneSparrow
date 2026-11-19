import type {
  PlanningContent,
  PlanningState,
  ManuscriptCommand,
  OutlineNode,
  EditGroup,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import { ProjectSession } from "../project-session/project-session";
import type { SaveStatus } from "../project-session/types";
export function normalizePlanningLanguage(language: string) {
  return /^(zh[_-]cn|zh[_-]hans(?:[_-]cn)?|zh|chinese|中文|简体中文)$/i.test(
    language,
  )
    ? "zh-CN"
    : language;
}
const contentKey = (p: PlanningContent) =>
  JSON.stringify([
    [
      p.brief.topic,
      p.brief.language,
      p.brief.audience,
      p.brief.style,
      p.brief.lengthHint,
    ],
    p.nodes.map((n) => [n.id, n.depth, n.title, n.keyPoints]),
    p.instruction,
    p.evidence.map((e) => [
      e.sourceId,
      e.mode,
      e.start,
      e.end,
      e.visualId,
      e.allowUnknownImages,
    ]),
  ]);
export class PlanningAutosave {
  local: PlanningContent;
  state: PlanningState;
  status: SaveStatus = "saved";
  error = "";
  composing = false;
  recoveryText: string | null = null;
  private conversionError = false;
  busy = false;
  private disposed = false;
  private generation = 0;
  private readEpoch = 0;
  private discardEpoch = 0;
  private discarding = false;
  private version = 0;
  private knownRejection = false;
  private pendingSave: ManuscriptCommand | null = null;
  private pendingReceiptAcknowledged = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastInput = 0;
  private scope = "";
  private groupId = crypto.randomUUID();
  private session = crypto.randomUUID();
  private sequences = new Map<string, number>();
  private open: EditGroup | null = null;
  private segments: {
    content: PlanningContent;
    groupId: string;
    kind: "typing" | "discrete";
  }[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private captureFences = new Map<
    object,
    {
      segments: readonly {
        content: PlanningContent;
        groupId: string;
        kind: "typing" | "discrete";
      }[];
    }
  >();
  private get captureFence() {
    return this.captureFences.values().next().value;
  }
  private adapter;
  constructor(
    state: PlanningState,
    private save: ProjectSession,
    private client: PlatformClient,
    private projectId: string,
    private changed: () => void,
  ) {
    this.state = state;
    this.local = structuredClone(state.content);
    this.local.brief.language = normalizePlanningLanguage(
      this.local.brief.language,
    );
    this.adapter = {
      flush: (retry = false) => this.flush(true, retry),
      captureCheckpoint: () => {
        const generation = this.generation;
        const discardEpoch = this.discardEpoch;
        const available = !this.discarding;
        this.capture();
        const segments = [...this.segments];
        const fence = { segments };
        this.captureFences.set(fence, fence);
        this.groupId = crypto.randomUUID();
        return {
          run: () =>
            available && discardEpoch === this.discardEpoch
              ? this.flush(true, true, { generation, segments, discardEpoch })
              : Promise.resolve(false),
          release: () => {
            this.captureFences.delete(fence);
            this.boundSegments();
          },
        };
      },
      identity: () => this.identity(),
      inputVersion: () => this.generation,
      refresh: async () => {
        await this.refresh();
      },
      dirty: () => this.status !== "saved",
      autosave: () => this.flush(false),
      busy: () => this.busy,
      canAutosave: () => !["error", "conflict"].includes(this.status),
    };
    save.planningAdapter = this.adapter;
  }
  identity() {
    return this.conversionError
      ? JSON.stringify([contentKey(this.local), this.recoveryText])
      : contentKey(this.local);
  }
  private notify() {
    if (!this.disposed) this.changed();
    this.save.settlementChanged();
  }
  invalidate(rawText: string) {
    if (this.disposed) return;
    this.generation++;
    this.conversionError = true;
    this.recoveryText = rawText;
    this.status = "pending";
    this.error = "";
    clearTimeout(this.idleTimer);
    this.notify();
    this.schedule();
  }
  edit(content: PlanningContent, scope: string, discrete = false) {
    if (this.disposed) return;
    if (this.conversionError) {
      // Brief and evidence edits must never clear an invalid central outline.
      this.local = content;
      this.generation++;
      this.notify();
      return;
    }
    if (["error", "conflict"].includes(this.status)) {
      this.local = content;
      this.generation++;
      if (
        this.knownRejection &&
        [
          "BRIEF_INVALID",
          "OUTLINE_INVALID",
          "EVIDENCE_CHOICE_REQUIRED",
        ].includes(this.error)
      ) {
        this.status = "pending";
        this.error = "";
        if (this.save.failureOwner === "planning")
          this.save.acknowledgeBusinessRejection(true);
        this.schedule();
      }
      this.notify();
      return;
    }
    const now = Date.now();
    if (discrete || this.scope !== scope || now - this.lastInput >= 750) {
      this.capture();
      this.groupId = crypto.randomUUID();
    }
    this.generation++;
    this.scope = scope;
    this.lastInput = now;
    this.local = content;
    this.boundSegments(5);
    this.status = "pending";
    this.error = "";
    if (discrete) {
      this.capture("discrete");
      this.groupId = crypto.randomUUID();
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.composing || this.disposed) return;
      this.capture();
      this.groupId = crypto.randomUUID();
      this.scope = "";
    }, 750);
    this.notify();
    this.schedule();
  }
  editOutline(nodes: OutlineNode[], discrete = false) {
    if (this.conversionError) {
      this.conversionError = false;
      this.recoveryText = null;
      this.error = "";
      this.status = "pending";
    }
    this.edit(
      { ...this.local, nodes },
      discrete ? "outline-structure" : "outline",
      discrete,
    );
  }
  composition(active: boolean) {
    if (active) this.capture();
    if (active) this.generation++;
    this.composing = active;
    this.save.composition(active, "planning");
    if (!active) {
      this.groupId = crypto.randomUUID();
      this.schedule();
    }
    this.notify();
  }
  compositionBlur(beforeCommit?: () => void) {
    this.save.actions.blur("planning", () => {
      beforeCommit?.();
      this.composition(false);
      this.boundary();
    });
  }
  afterComposition(action: () => void, key = "planning-evidence") {
    void this.save.actions.run(key, action, () => !this.disposed);
  }
  boundary() {
    if (this.disposed || this.composing) return;
    clearTimeout(this.idleTimer);
    this.capture();
    this.groupId = crypto.randomUUID();
    this.scope = "";
  }
  private capture(kind: "typing" | "discrete" = "typing") {
    if (this.composing || this.disposed || this.conversionError) return;
    const previous = this.segments.at(-1)?.content ?? this.state.content;
    if (contentKey(previous) !== this.identity()) {
      const segment = {
        content: structuredClone(this.local),
        groupId: this.groupId,
        kind,
      };
      const last = this.segments.at(-1);
      if (
        last?.groupId === this.groupId &&
        !(this.pendingSave && this.segments.length === 1)
      )
        this.segments[this.segments.length - 1] = segment;
      else this.segments.push(segment);
      // The first captured payload may still own an ambiguous command/readback.
      this.boundSegments();
    }
  }
  private boundSegments(limit = 6) {
    const protectedSegments = new Set(
      [...this.captureFences.values()].flatMap((fence) => [...fence.segments]),
    );
    if (this.pendingSave && this.segments[0])
      protectedSegments.add(this.segments[0]);
    let ordinary = this.segments.filter(
      (segment) => !protectedSegments.has(segment),
    ).length;
    this.segments = this.segments.filter(
      (segment) => protectedSegments.has(segment) || ordinary-- <= limit,
    );
  }

  private schedule() {
    this.save.inputActivity();
  }
  private enqueue<T>(action: () => Promise<T>) {
    const p = this.tail.then(action);
    this.tail = p.catch(() => {});
    return p;
  }
  flush(
    close = true,
    retry = false,
    captured?: {
      generation: number;
      discardEpoch: number;
      segments: readonly {
        content: PlanningContent;
        groupId: string;
        kind: "typing" | "discrete";
      }[];
    },
  ): Promise<boolean> {
    const backgroundGeneration =
      captured?.generation ?? (close ? undefined : this.generation);
    // A captured participant already runs inside the shared queue. Waiting for
    // discard then re-entering an ordinary flush would await that same queue.
    if (captured && captured.discardEpoch !== this.discardEpoch)
      return Promise.resolve(false);
    if (this.discarding)
      return captured
        ? Promise.resolve(false)
        : this.tail.then(() => this.flush(close, retry));
    if (
      this.conversionError &&
      !(!captured && this.composing) &&
      !this.disposed
    ) {
      this.status = "error";
      this.error = "OUTLINE_INVALID";
      this.notify();
      return Promise.resolve(false);
    }
    if (
      (!captured && this.composing) ||
      this.disposed ||
      this.conversionError ||
      this.status === "conflict" ||
      (!retry && this.status === "error")
    )
      return Promise.resolve(false);
    if (this.knownRejection) {
      if (!this.save.acknowledgeBusinessRejection(true))
        return Promise.resolve(false);
      this.knownRejection = false;
    }
    if (!captured && !this.captureFence) this.capture();
    const execute = async () => {
      if (
        this.disposed ||
        (captured && captured.discardEpoch !== this.discardEpoch) ||
        (!captured && this.composing) ||
        this.conversionError
      )
        return false;
      this.busy = true;
      this.notify();
      try {
        for (;;) {
          while (
            this.segments.length &&
            (!(captured ?? this.captureFence) ||
              (captured ?? this.captureFence)!.segments.includes(
                this.segments[0]!,
              ))
          ) {
            if (
              (!captured && this.composing) ||
              this.disposed ||
              this.conversionError
            )
              return false;
            const segment = this.segments[0]!;
            const groupSequence =
              (this.sequences.get(segment.groupId) ?? 0) + 1;
            const group: EditGroup = {
              clientSessionId: this.session,
              groupId: segment.groupId,
              groupSequence,
              kind: segment.kind,
            };
            // Rebase only server-assigned tokens; visible words/order remain the
            // captured segment, including input entered during a previous receipt.
            const content = structuredClone(segment.content);
            for (const n of content.nodes)
              n.revision =
                this.state.content.nodes.find((old) => old.id === n.id)
                  ?.revision ?? 0;
            this.status = "saving";
            this.notify();
            const ok =
              this.pendingReceiptAcknowledged ||
              (await this.save.businessCore(
                (revision) =>
                  this.pendingSave ??
                  (this.pendingSave = {
                    type: "SavePlanning",
                    requestId: crypto.randomUUID(),
                    projectId: this.projectId,
                    expectedWorkingRevision: revision,
                    payload: { content, group },
                  }),
                {
                  replayCommand: () => this.pendingSave,
                  bodyPreserving: true,
                  background: !close,
                  insideQueue: true,
                  capturedInput: !!captured || !!this.captureFence,
                },
              ));
            if (!ok) {
              if (!this.pendingSave) {
                // Body settlement can fail before the plan builder is dispatched.
                // The body owner keeps its receipt/error; this plan remains pending.
                this.status = "pending";
                this.error = "";
                return false;
              }
              if (
                !this.save.hasUnresolvedBusiness &&
                this.save.status !== "conflict"
              ) {
                this.pendingSave = null;
                this.segments = [];
                this.knownRejection = true;
              }
              this.error = this.save.error;
              this.status =
                this.save.status === "conflict" ? "conflict" : "error";
              return false;
            }
            this.pendingReceiptAcknowledged = true;
            const canonical = await this.client.readPlanning();
            if (contentKey(canonical.content) !== contentKey(content)) {
              this.error = "REVISION_CONFLICT";
              this.status = "conflict";
              return false;
            }
            if (
              this.disposed ||
              (captured && captured.discardEpoch !== this.discardEpoch)
            )
              return false;
            this.pendingSave = null;
            this.pendingReceiptAcknowledged = false;
            this.version++;
            this.state = canonical;
            this.open = group;
            this.sequences.set(group.groupId, groupSequence);
            this.segments.shift();
            for (const n of this.local.nodes)
              n.revision =
                canonical.content.nodes.find((old) => old.id === n.id)
                  ?.revision ?? n.revision;
            if (
              !captured &&
              backgroundGeneration !== undefined &&
              backgroundGeneration !== this.generation
            ) {
              this.status = "pending";
              return true;
            }
            if (!captured && !this.captureFence) this.capture();
          }
          if (!captured && this.composing) {
            this.status = "pending";
            return false;
          }
          if (this.open && (close || this.open.groupId !== this.groupId)) {
            const group = this.open;
            this.groupId = crypto.randomUUID();
            this.scope = "";
            const ok = await this.save.businessCore(
              (revision) => ({
                type: "CloseEditGroup",
                requestId: crypto.randomUUID(),
                projectId: this.projectId,
                expectedWorkingRevision: revision,
                expectedHistoryRevision: this.save.history.historyRevision,
                expectedCursor: this.save.history.cursor,
                payload: {
                  clientSessionId: group.clientSessionId,
                  groupId: group.groupId,
                  groupSequence: group.groupSequence,
                },
              }),
              {
                bodyPreserving: true,
                background: !close,
                insideQueue: true,
                capturedInput: !!captured || !!this.captureFence,
              },
            );
            if (!ok) {
              this.error =
                this.save.failureOwner === "manuscript" ? "" : this.save.error;
              this.status =
                this.save.failureOwner === "manuscript" ? "pending" : "error";
              return false;
            }
            this.open = null;
          }
          if (
            (!captured && this.composing) ||
            this.disposed ||
            this.conversionError
          )
            return false;
          if (
            backgroundGeneration !== undefined &&
            backgroundGeneration !== this.generation
          ) {
            this.status = "pending";
            return true;
          }
          if (!captured && !this.captureFence) this.capture();
          if (this.segments.length && !captured && !this.captureFence) continue;
          this.status =
            !this.segments.length &&
            this.identity() === contentKey(this.state.content)
              ? "saved"
              : "pending";
          return true;
        }
      } catch (e) {
        this.error = e instanceof Error ? e.message : "STORAGE_UNAVAILABLE";
        this.status = "error";
        return false;
      } finally {
        if (this.conversionError && this.status === "saving") {
          this.status = "pending";
          this.error = "";
        }
        this.busy = false;
        this.notify();
      }
    };
    return captured
      ? execute()
      : this.enqueue(() => this.save.planningFlush(execute));
  }
  async control(build: (revision: number) => ManuscriptCommand) {
    const intent = this.identity();
    if (!(await this.flush()) || this.identity() !== intent || this.composing)
      return false;
    const ok = await this.save.businessCore(build, {
      validIntent: () => this.identity() === intent,
      bodyPreserving: true,
    });
    if (ok) await this.refresh();
    else {
      this.error = this.save.error;
      this.status = this.save.status === "conflict" ? "conflict" : "error";
      this.notify();
    }
    return ok;
  }
  async refresh(discard = false) {
    if (discard) return this.discard();
    if (this.busy || this.disposed || this.composing || this.discarding) return;
    const epoch = ++this.readEpoch,
      generation = this.generation,
      version = this.version;
    const current = await this.client.readPlanning();
    if (
      this.disposed ||
      this.busy ||
      this.composing ||
      this.discarding ||
      epoch !== this.readEpoch ||
      generation !== this.generation ||
      version !== this.version
    )
      return;
    if (this.conversionError) {
      this.state = {
        ...this.state,
        tasks: current.tasks,
        reserved: current.reserved,
      };
      this.notify();
      return;
    }
    const changed =
      contentKey(current.content) !== contentKey(this.state.content);
    if (this.status === "saved") {
      this.state = current;
      this.local = structuredClone(current.content);
      this.local.brief.language = normalizePlanningLanguage(
        this.local.brief.language,
      );
    } else {
      this.state = {
        ...this.state,
        tasks: current.tasks,
        reserved: current.reserved,
      };
      // A committed save can still await its canonical read after a read failure.
      // Refresh must not classify that exact acknowledged payload as external;
      // flush retains ownership of settling its pending receipt and segments.
      const ownAcknowledgedContent =
        this.pendingReceiptAcknowledged &&
        this.pendingSave?.type === "SavePlanning" &&
        contentKey(current.content) ===
          contentKey(this.pendingSave.payload.content);
      if (changed && !ownAcknowledgedContent) {
        this.status = "conflict";
        this.error = "REVISION_CONFLICT";
      }
    }
    this.notify();
  }
  discard() {
    clearTimeout(this.idleTimer);
    return this.enqueue(async () => {
      // Do not flush a newer draft to discover whether an older request landed.
      if (
        this.disposed ||
        this.composing ||
        this.save.hasUnresolvedBusiness ||
        (this.pendingSave &&
          !this.knownRejection &&
          !this.pendingReceiptAcknowledged)
      ) {
        this.error = "COMMAND_UNRESOLVED";
        this.notify();
        return false;
      }
      const generation = this.generation;
      const sharedEpoch = `${this.save.state.workingRevision}:${this.save.history.historyRevision}:${this.save.history.cursor}`;
      this.discarding = true;
      this.discardEpoch++;
      this.readEpoch++;
      let current: PlanningState;
      try {
        current = await this.client.readPlanning();
      } catch {
        this.error = "STORAGE_UNAVAILABLE";
        this.notify();
        return false;
      } finally {
        this.discarding = false;
      }
      if (
        this.disposed ||
        generation !== this.generation ||
        this.composing ||
        sharedEpoch !==
          `${this.save.state.workingRevision}:${this.save.history.historyRevision}:${this.save.history.cursor}`
      )
        return false;
      this.readEpoch++;
      this.version++;
      this.state = current;
      this.local = structuredClone(current.content);
      this.local.brief.language = normalizePlanningLanguage(
        this.local.brief.language,
      );
      this.segments = [];
      this.open = null;
      this.pendingSave = null;
      this.pendingReceiptAcknowledged = false;
      this.knownRejection = false;
      this.save.acknowledgeBusinessRejection(true);
      this.conversionError = false;
      this.recoveryText = null;
      this.error = "";
      this.status = "saved";
      this.notify();
      return true;
    });
  }
  dispose() {
    this.save.actions.cancel("planning-start");
    this.save.actions.cancel("planning-control");
    this.save.actions.cancelScope("planning-evidence:");
    this.save.composition(false, "planning");
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.save.planningAdapter === this.adapter)
      delete this.save.planningAdapter;
  }
}
