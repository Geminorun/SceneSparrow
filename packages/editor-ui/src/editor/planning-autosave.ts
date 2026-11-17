import type {
  PlanningContent,
  PlanningState,
  ManuscriptCommand,
  EditGroup,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import { Autosave, type SaveStatus } from "./autosave";
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
  busy = false;
  private disposed = false;
  private generation = 0;
  private readEpoch = 0;
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
  private deferredActions: (() => void)[] = [];
  private adapter;
  constructor(
    state: PlanningState,
    private save: Autosave,
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
      identity: () => this.identity(),
      dirty: () => this.status !== "saved",
      autosave: () => this.flush(false),
      busy: () => this.busy,
      canAutosave: () => !["error", "conflict"].includes(this.status),
    };
    save.planningAdapter = this.adapter;
  }
  identity() {
    return contentKey(this.local);
  }
  private notify() {
    if (!this.disposed) this.changed();
    this.save.settlementChanged();
  }
  edit(content: PlanningContent, scope: string, discrete = false) {
    if (this.disposed) return;
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
  composition(active: boolean) {
    if (active) this.capture();
    if (active) this.generation++;
    this.composing = active;
    this.save.composition(active);
    if (!active) {
      this.groupId = crypto.randomUUID();
      this.schedule();
      const actions = this.deferredActions.splice(0);
      queueMicrotask(() => {
        if (!this.disposed) for (const action of actions) action();
      });
    }
    this.notify();
  }
  afterComposition(action: () => void) {
    if (this.composing) this.deferredActions.push(action);
    else action();
  }
  boundary() {
    if (this.disposed || this.composing) return;
    clearTimeout(this.idleTimer);
    this.capture();
    this.groupId = crypto.randomUUID();
    this.scope = "";
  }
  private capture(kind: "typing" | "discrete" = "typing") {
    if (this.composing || this.disposed) return;
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
    const protectedCount = this.pendingSave ? 1 : 0;
    if (this.segments.length > limit + protectedCount)
      this.segments.splice(
        protectedCount,
        this.segments.length - limit - protectedCount,
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
  flush(close = true, retry = false): Promise<boolean> {
    const backgroundGeneration = close ? undefined : this.generation;
    if (this.discarding) return this.tail.then(() => this.flush(close, retry));
    if (
      this.composing ||
      this.disposed ||
      this.status === "conflict" ||
      (!retry && this.status === "error")
    )
      return Promise.resolve(false);
    if (this.knownRejection) {
      if (!this.save.acknowledgeBusinessRejection(true))
        return Promise.resolve(false);
      this.knownRejection = false;
    }
    this.capture();
    return this.enqueue(async () => {
      if (this.disposed || this.composing) return false;
      this.busy = true;
      this.notify();
      try {
        for (;;) {
          while (this.segments.length) {
            if (this.composing || this.disposed) return false;
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
            if (this.disposed) return false;
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
              backgroundGeneration !== undefined &&
              backgroundGeneration !== this.generation
            ) {
              this.status = "pending";
              return true;
            }
            this.capture();
          }
          if (this.composing) {
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
              { bodyPreserving: true, background: !close },
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
          if (this.composing || this.disposed) return false;
          if (
            backgroundGeneration !== undefined &&
            backgroundGeneration !== this.generation
          ) {
            this.status = "pending";
            return true;
          }
          this.capture();
          if (this.segments.length) continue;
          this.status = "saved";
          return true;
        }
      } catch (e) {
        this.error = e instanceof Error ? e.message : "STORAGE_UNAVAILABLE";
        this.status = "error";
        return false;
      } finally {
        this.busy = false;
        this.notify();
      }
    });
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
      this.error = "";
      this.status = "saved";
      this.notify();
      return true;
    });
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.save.planningAdapter === this.adapter)
      delete this.save.planningAdapter;
  }
}
