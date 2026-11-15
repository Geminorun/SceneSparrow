import type {
  ManuscriptCommand,
  ManuscriptState,
  NewBlock,
  CommandReceipt,
} from "@scenesparrow/contracts";
import { ApiError, type PlatformClient } from "@scenesparrow/platform-client";
import { edits } from "./canonical";
export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";
class UncertainCommit extends Error {}
export class Autosave {
  local: NewBlock[];
  status: SaveStatus = "saved";
  error = "";
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
  private sequence = 0;
  constructor(
    public state: ManuscriptState,
    private projectId: string,
    private client: PlatformClient,
    private changed: () => void,
  ) {
    this.local = state.blocks.map(({ revision: _, ...b }) => b);
  }
  private same() {
    return (
      JSON.stringify(this.local) ===
      JSON.stringify(this.state.blocks.map(({ revision: _, ...b }) => b))
    );
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
    this.composing = active;
    if (active) clearTimeout(this.timer);
    else this.schedule();
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
    if (this.inFlight || this.unresolved) return false;
    const command: ManuscriptCommand = {
      type: "StartManualDraft",
      requestId: crypto.randomUUID(),
      projectId: this.projectId,
      expectedWorkingRevision: this.state.workingRevision,
      payload: {},
    };
    this.unresolved = { command, blocks: [] };
    return this.flush(true);
  }
  async flush(retry = false): Promise<boolean> {
    if (this.disposed) return false;
    clearTimeout(this.timer);
    if (this.composing || this.conversionError) return false;
    if (this.inFlight) {
      const ok = await this.inFlight;
      return ok ? this.flush() : false;
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
      let payload;
      try {
        payload = edits(this.state.blocks, this.local);
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
            groupId: this.group,
            groupSequence: ++this.sequence,
            kind: "typing",
          },
        },
      };
      this.unresolved = { command, blocks: structuredClone(this.local) };
    }
    const sent = this.unresolved;
    this.status = "saving";
    this.notify();
    this.inFlight = (async () => {
      try {
        // A retry always resolves/replays the original identity before any newer edit.
        const receipt = await this.resolve(sent.command);
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
                receipt.blockRevisions.find((r) => r.id === b.id)?.revision ??
                this.state.blocks.find((old) => old.id === b.id)?.revision ??
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
            this.group = crypto.randomUUID();
            this.sequence = 0;
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
      ? this.flush()
      : ok;
  }
  async reload() {
    if (this.inFlight) return false;
    try {
      this.state = await this.client.readManuscript();
      this.local = this.state.blocks.map(({ revision: _, ...b }) => b);
      this.unresolved = null;
      this.group = crypto.randomUUID();
      this.sequence = 0;
      this.conversionError = null;
      this.recoveryText = null;
      this.status = "saved";
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
  }
}
