import type {
  PlanningContent,
  PlanningState,
  ManuscriptCommand,
  EditGroup,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import { Autosave, type SaveStatus } from "./autosave";
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
  private version = 0;
  private knownRejection = false;
  private pendingSave: ManuscriptCommand | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private first = 0;
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
    this.adapter = {
      flush: (retry = false) => this.flush(true, retry),
      identity: () => this.identity(),
      dirty: () => this.status !== "saved",
    };
    save.planningAdapter = this.adapter;
  }
  identity() {
    return contentKey(this.local);
  }
  private notify() {
    if (!this.disposed) this.changed();
  }
  edit(content: PlanningContent, scope: string, discrete = false) {
    if (this.disposed) return;
    if (["error", "conflict"].includes(this.status)) {
      this.local = content;
      this.generation++;
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
    this.status = "pending";
    this.error = "";
    if (discrete) {
      this.capture("discrete");
      this.groupId = crypto.randomUUID();
    }
    this.notify();
    this.schedule();
  }
  composition(active: boolean) {
    if (active) this.capture();
    this.composing = active;
    this.save.composing = active;
    if (active) clearTimeout(this.timer);
    else {
      this.groupId = crypto.randomUUID();
      this.schedule();
    }
    this.notify();
  }
  private capture(kind: "typing" | "discrete" = "typing") {
    if (this.composing || this.disposed) return;
    const previous = this.segments.at(-1)?.content ?? this.state.content;
    if (contentKey(previous) !== this.identity())
      this.segments.push({
        content: structuredClone(this.local),
        groupId: this.groupId,
        kind,
      });
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.composing) return;
    if (!this.first) this.first = Date.now();
    this.timer = setTimeout(
      () => void this.flush(false),
      Math.min(300, Math.max(0, 2000 - (Date.now() - this.first))),
    );
  }
  private enqueue<T>(action: () => Promise<T>) {
    const p = this.tail.then(action);
    this.tail = p.catch(() => {});
    return p;
  }
  flush(close = true, retry = false) {
    if (
      this.composing ||
      this.disposed ||
      this.status === "conflict" ||
      (!retry && this.status === "error")
    )
      return Promise.resolve(false);
    if (this.knownRejection) {
      if (!this.save.acknowledgeBusinessRejection())
        return Promise.resolve(false);
      this.knownRejection = false;
    }
    clearTimeout(this.timer);
    this.first = 0;
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
            const ok = await this.save.businessCore(
              (revision) =>
                this.pendingSave ??
                (this.pendingSave = {
                  type: "SavePlanning",
                  requestId: crypto.randomUUID(),
                  projectId: this.projectId,
                  expectedWorkingRevision: revision,
                  payload: { content, group },
                }),
              { replayCommand: () => this.pendingSave },
            );
            if (!ok) {
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
            const canonical = await this.client.readPlanning();
            if (contentKey(canonical.content) !== contentKey(content)) {
              this.error = "REVISION_CONFLICT";
              this.status = "conflict";
              return false;
            }
            if (this.disposed) return false;
            this.pendingSave = null;
            this.version++;
            this.state = canonical;
            this.open = group;
            this.sequences.set(group.groupId, groupSequence);
            this.segments.shift();
            for (const n of this.local.nodes)
              n.revision =
                canonical.content.nodes.find((old) => old.id === n.id)
                  ?.revision ?? n.revision;
            this.capture();
          }
          if (this.composing) {
            this.status = "pending";
            return false;
          }
          if (close && this.open) {
            const group = this.open;
            this.groupId = crypto.randomUUID();
            this.scope = "";
            const ok = await this.save.businessCore((revision) => ({
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
            }));
            if (!ok) {
              this.error = this.save.error;
              this.status = "error";
              return false;
            }
            this.open = null;
          }
          if (this.composing || this.disposed) return false;
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
    if (this.busy || this.disposed) return;
    const epoch = ++this.readEpoch,
      generation = this.generation,
      version = this.version;
    const current = await this.client.readPlanning();
    if (
      this.disposed ||
      this.busy ||
      epoch !== this.readEpoch ||
      generation !== this.generation ||
      version !== this.version
    )
      return;
    const changed =
      contentKey(current.content) !== contentKey(this.state.content);
    if (discard || this.status === "saved") {
      this.state = current;
      this.local = structuredClone(current.content);
      if (discard) {
        this.segments = [];
        this.open = null;
        this.pendingSave = null;
        this.error = "";
        this.status = "saved";
        await this.save.reload();
      }
    } else {
      this.state = {
        ...this.state,
        tasks: current.tasks,
        reserved: current.reserved,
      };
      if (changed) {
        this.status = "conflict";
        this.error = "REVISION_CONFLICT";
      }
    }
    this.notify();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    if (this.save.planningAdapter === this.adapter)
      delete this.save.planningAdapter;
  }
}
