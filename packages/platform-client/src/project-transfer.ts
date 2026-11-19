import type * as C from "@scenesparrow/contracts";
import type { BridgeResult } from "./types";
export interface ProjectTransferClient {
  inspectLegacyMigration?(): Promise<C.LegacyMigrationInspection>;
  issueMigrationTarget?(
    request: C.MigrationTargetRequest,
  ): Promise<C.MigrationTarget>;
  startLegacyMigration?(
    request: C.LegacyMigrationRequest,
  ): Promise<C.MigrationStartResponse>;
  readMigrationOperation?(requestId: string): Promise<C.MigrationOperationView>;
  controlMigration?(
    request: C.MigrationControlRequest,
  ): Promise<C.MigrationOperationView>;
}
export type ProjectTransferBridge = {
  [K in keyof ProjectTransferClient]?: NonNullable<
    ProjectTransferClient[K]
  > extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<BridgeResult<R>>
    : never;
};
