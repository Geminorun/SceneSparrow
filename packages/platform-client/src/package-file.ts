import { safePackageFilename } from "./package-name.mjs";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  PackageIntakeRequest,
  PackageIntakeView,
  PackageIntakeControlRequest,
} from "@scenesparrow/contracts";
import type { ProjectPackageClient } from "./project-package";
import { ApiError } from "./errors";
export const PACKAGE_CHUNK_BYTES = 1024 * 1024;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
/** Retains the selected File and original intake identity, never its bytes in recovery hints. */
export class PackageFileUpload {
  readonly controller = new AbortController();
  request: PackageIntakeRequest | undefined;
  intake: PackageIntakeView | undefined;
  private cancelRequest: PackageIntakeControlRequest | undefined;
  private cancelPromise: Promise<void> | undefined;
  constructor(
    readonly client: ProjectPackageClient,
    readonly ownerProjectId: string,
    readonly file: File,
    private valid: () => boolean = () => true,
  ) {}
  private guard() {
    if (this.controller.signal.aborted || !this.valid())
      throw new ApiError("PACKAGE_CANCELLED");
  }
  async run(
    progress: (
      phase: "hash" | "upload",
      completed: number,
      total: number,
    ) => void,
  ) {
    this.guard();
    if (!this.file.size || this.file.size > 8 * 1024 ** 3)
      throw new ApiError("PACKAGE_SIZE_LIMIT");
    if (!this.request) {
      const hash = sha256.create();
      for (
        let offset = 0;
        offset < this.file.size;
        offset += PACKAGE_CHUNK_BYTES
      ) {
        const bytes = new Uint8Array(
          await this.file
            .slice(offset, offset + PACKAGE_CHUNK_BYTES)
            .arrayBuffer(),
        );
        this.guard();
        hash.update(bytes);
        progress("hash", offset + bytes.length, this.file.size);
      }
      this.request = {
        requestId: crypto.randomUUID(),
        ownerProjectId: this.ownerProjectId,
        filename: safePackageFilename(this.file.name),
        length: this.file.size,
        hash: hex(hash.digest()),
      };
    }
    this.guard();
    // create is idempotent with this original request; received extent is core-owned.
    this.intake = await this.client.createPackageIntake!(this.request);
    this.guard();
    this.intake = await this.client.readPackageIntake!(this.intake.intakeId);
    this.guard();
    if (
      this.intake.ownerProjectId !== this.ownerProjectId ||
      this.intake.length !== this.file.size ||
      this.intake.hash !== this.request.hash
    )
      throw new ApiError("PACKAGE_CHUNK_CONFLICT");
    while (this.intake.receivedBytes < this.file.size) {
      const offset: number = this.intake.receivedBytes;
      const bytes = new Uint8Array(
        await this.file
          .slice(offset, offset + PACKAGE_CHUNK_BYTES)
          .arrayBuffer(),
      );
      this.guard();
      const chunk = {
        ownerProjectId: this.ownerProjectId,
        intakeId: this.intake.intakeId,
        offset,
        length: bytes.length,
        hash: hex(sha256(bytes)),
      };
      const ack = await this.client.uploadPackageChunk!(chunk, bytes);
      this.guard();
      if (
        ack.intakeId !== chunk.intakeId ||
        ack.offset !== offset ||
        ack.length !== bytes.length ||
        ack.hash !== chunk.hash ||
        ack.acknowledgedEnd !== offset + bytes.length
      )
        throw new ApiError("PACKAGE_CHUNK_CONFLICT");
      this.intake = { ...this.intake, receivedBytes: ack.acknowledgedEnd };
      progress("upload", ack.acknowledgedEnd, this.file.size);
    }
    this.intake = await this.client.readPackageIntake!(this.intake.intakeId);
    this.guard();
    return this.intake;
  }
  cancel(): Promise<void> {
    this.controller.abort();
    if (this.cancelPromise) return this.cancelPromise;
    const promise = (async () => {
      const intakeId = this.intake?.intakeId ?? this.request?.requestId;
      if (!intakeId) return;
      if (!this.cancelRequest) {
        const current = await this.client.readPackageIntake!(intakeId);
        this.cancelRequest = {
          requestId: crypto.randomUUID(),
          ownerProjectId: this.ownerProjectId,
          intakeId: current.intakeId,
          expectedRevision: current.revision,
          action: "cancel",
        };
      }
      this.intake = await this.client.controlPackageIntake!(this.cancelRequest);
    })();
    this.cancelPromise = promise.catch((error) => {
      this.cancelPromise = undefined;
      if (
        error instanceof ApiError &&
        error.code === "PACKAGE_REVISION_CONFLICT"
      )
        this.cancelRequest = undefined;
      throw error;
    });
    return this.cancelPromise;
  }
}
