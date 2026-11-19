import type * as C from "@scenesparrow/contracts";
import type { BridgeResult } from "./types";
export interface ProjectPackageClient {
  choosePackageIntake?(
    request: C.NativePackageIntakeRequest,
  ): Promise<C.NativePackageIntakeResult>;
  cancelNativePackageIntake?(
    request: C.NativePackageCancelRequest,
  ): Promise<boolean>;
  readNativePackageSave?(
    request: C.NativePackageSaveRequest,
  ): Promise<C.NativePackageSaveResult>;
  savePackageArchive?(
    request: C.NativePackageSaveRequest,
  ): Promise<C.NativePackageSaveResult>;
  readPackageBase?(): Promise<C.ProjectPackageBase>;
  startProjectPackageExport?(
    request: C.ProjectPackageExportRequest,
  ): Promise<C.PackageStartResponse>;
  startWorkCopyPackageExport?(
    request: C.WorkCopyPackageExportRequest,
  ): Promise<C.PackageStartResponse>;
  readPackageOperation?(id: string): Promise<C.PackageOperationView>;
  controlPackageOperation?(
    request: C.PackageControlRequest,
  ): Promise<C.PackageOperationView>;
  createPackageIntake?(
    request: C.PackageIntakeRequest,
  ): Promise<C.PackageIntakeView>;
  readPackageIntake?(id: string): Promise<C.PackageIntakeView>;
  uploadPackageChunk?(
    request: C.PackageChunkRequest,
    bytes: Uint8Array,
  ): Promise<C.PackageChunkAck>;
  controlPackageIntake?(
    request: C.PackageIntakeControlRequest,
  ): Promise<C.PackageIntakeView>;
  inspectPackage?(
    request: C.PackageInspectionRequest,
  ): Promise<C.PackageStartResponse>;
  readPackageInspection?(id: string): Promise<C.PackageInspectionView>;
  issuePackageRestoreTarget?(
    request: C.PackageRestoreTargetRequest,
  ): Promise<C.PackageRestoreTarget>;
  restorePackage?(
    request: C.PackageRestoreRequest,
  ): Promise<C.PackageStartResponse>;
  returnPackage?(
    request: C.PackageReturnRequest,
  ): Promise<C.PackageStartResponse>;
  downloadPackageArchive?(archive: C.PackageArchiveView): Promise<boolean>;
  /** HTTP attachment stream. Native chooser/save streaming is supplied by the host. */
  openPackageArchive?(id: string): Promise<Response>;
}
export type ProjectPackageBridge = {
  [
    K in Exclude<
      keyof ProjectPackageClient,
      "openPackageArchive" | "downloadPackageArchive"
    >
  ]?: NonNullable<ProjectPackageClient[K]> extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => Promise<BridgeResult<R>>
    : never;
};
