import type {
  DeliveryAction,
  DeliveryReceipt,
  ExportJob,
} from "@scenesparrow/contracts";
export function deliveryError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return [
    "INVALID_REQUEST",
    "ARTIFACT_MISMATCH",
    "DESTINATION_CHANGED",
    "DESTINATION_LOCKED",
    "DESTINATION_UNAVAILABLE",
    "DELIVERY_STATUS_UNKNOWN",
    "CAPABILITY_EXPIRED",
    "ORIGIN_DENIED",
  ].includes(code)
    ? code
    : "DESTINATION_UNAVAILABLE";
}
export interface DeliveryPorts<T> {
  intent(action: DeliveryAction): Promise<DeliveryReceipt>;
  artifact(
    action: DeliveryAction,
  ): Promise<{ job: ExportJob; bytes: Uint8Array }>;
  choose(job: ExportJob): Promise<T | null>;
  commit(target: T, bytes: Uint8Array, hash: string): Promise<void>;
  finish(
    action: DeliveryAction,
    status: "saved" | "unknown" | "failed",
  ): Promise<DeliveryReceipt>;
}
/** Session-only capabilities never expose a path to the renderer or portable DB. */
export class NativeDelivery<T> {
  private receipts = new Map<
    string,
    { digest: string; task: Promise<DeliveryReceipt | null> }
  >();
  constructor(private ports: DeliveryPorts<T>) {}
  save(
    action: DeliveryAction,
    assertOwner: () => void,
  ): Promise<DeliveryReceipt | null> {
    const digest = JSON.stringify([
      action.deliveryId,
      action.jobId,
      action.artifactHash,
    ]);
    const previous = this.receipts.get(action.deliveryId);
    if (previous) {
      if (previous.digest !== digest)
        return Promise.reject(Error("INVALID_REQUEST"));
      return previous.task;
    }
    const task = this.perform(action, assertOwner);
    this.receipts.set(action.deliveryId, { digest, task });
    return task;
  }
  async settled() {
    await Promise.allSettled([...this.receipts.values()].map((r) => r.task));
  }
  clear() {
    this.receipts.clear();
  }
  private async perform(action: DeliveryAction, assertOwner: () => void) {
    assertOwner();
    const intent = await this.ports.intent(action);
    assertOwner();
    if (intent.status !== "intent") return intent;
    let finalized = false;
    try {
      const { job, bytes } = await this.ports.artifact(action);
      assertOwner();
      const target = await this.ports.choose(job);
      assertOwner();
      if (!target) {
        await this.ports.finish(action, "failed");
        return null;
      }
      await this.ports.commit(target, bytes, action.artifactHash);
      finalized = true;
      try {
        return await this.ports.finish(action, "saved");
      } catch {
        await this.ports.finish(action, "unknown").catch(() => {});
        return {
          ...intent,
          status: "unknown" as const,
          error: "DELIVERY_STATUS_UNKNOWN",
        };
      }
    } catch (e) {
      const code = deliveryError(e);
      const unknown = finalized || code === "DELIVERY_STATUS_UNKNOWN";
      await this.ports
        .finish(action, unknown ? "unknown" : "failed")
        .catch(() => {});
      if (unknown)
        return {
          ...intent,
          status: "unknown" as const,
          error: "DELIVERY_STATUS_UNKNOWN",
        };
      throw Error(code);
    }
  }
}
import type { ClipboardAction, PreparedCopy } from "@scenesparrow/contracts";
export class NativeClipboard {
  private receipts = new Map<string, { digest: string; task: Promise<void> }>();
  constructor(
    private read: (id: string) => Promise<PreparedCopy>,
    private write: (text: string) => void,
  ) {}
  copy(action: ClipboardAction, assertOwner: () => void): Promise<void> {
    const digest = JSON.stringify([
      action.deliveryId,
      action.preparationId,
      action.bodyHash,
    ]);
    const old = this.receipts.get(action.deliveryId);
    if (old) {
      if (old.digest !== digest)
        return Promise.reject(Error("INVALID_REQUEST"));
      return old.task;
    }
    const task = (async () => {
      assertOwner();
      const prepared = await this.read(action.preparationId);
      assertOwner();
      if (prepared.bodyHash !== action.bodyHash || !prepared.text)
        throw Error("ARTIFACT_MISMATCH");
      this.write(prepared.text);
    })();
    this.receipts.set(action.deliveryId, { digest, task });
    return task;
  }
  async settled() {
    await Promise.allSettled([...this.receipts.values()].map((r) => r.task));
  }
  clear() {
    this.receipts.clear();
  }
}
