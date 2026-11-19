import type * as C from "@scenesparrow/contracts";
import type { BridgeResult } from "./types";

export interface ExternalWorkClient {
  inspectGraphRecovery?(intent: string): Promise<C.GraphRecoveryInspection>;
  readFileGraph?(): Promise<C.FileGraphView>;
  readGraphFiles?(cursor?: string): Promise<C.GraphFilePage>;
  registerFileGraph?(
    request: C.GraphRegisterRequest,
  ): Promise<C.AuthoredSourceSaveResponse>;
  createWorkItem?(
    request: C.WorkItemCreateRequest,
  ): Promise<C.WorkMutationResponse>;
  readWorkItems?(cursor?: string): Promise<C.WorkItemPage>;
  readWorkItem?(id: string): Promise<C.WorkItemView>;
  inspectWorkItem?(
    request: C.WorkItemInspectRequest,
  ): Promise<C.WorkMutationResponse>;
  acceptWorkCandidate?(
    request: C.WorkCandidateAcceptRequest,
  ): Promise<C.AuthoredSourceSaveResponse>;
  discardWorkItem?(
    request: C.WorkItemDiscardRequest,
  ): Promise<C.AuthoredSourceSaveResponse>;
  controlWorkItem?(
    request: C.WorkItemControlRequest,
  ): Promise<C.WorkMutationResponse>;
  readWorkOperation?(requestId: string): Promise<C.WorkOperationView>;
  readWorkCandidate?(
    item: string,
    candidate: string,
  ): Promise<C.WorkCandidateView>;
  readWorkChanges?(
    item: string,
    candidate: string,
    cursor?: string,
  ): Promise<C.WorkChangePage>;
  readProductionFileLocks?(cursor?: string): Promise<C.ProductionFileLockPage>;
  setProductionFileLocks?(
    request: C.ProductionFileLockRequest,
  ): Promise<C.AuthoredSourceSaveResponse>;
  readGraphRecoveries?(cursor?: string): Promise<C.GraphRecoveryPage>;
  readGraphRecoveryMembers?(
    intent: string,
    cursor?: string,
  ): Promise<C.GraphRecoveryMemberPage>;
  downloadWorkCandidateMember?(
    item: string,
    candidate: string,
    member: string,
    role: "before" | "after",
  ): Promise<boolean>;
  downloadGraphRecoveryMember?(
    intent: string,
    member: string,
  ): Promise<boolean>;
  revealWorkItem?(id: string): Promise<boolean>;
}
export type ExternalWorkBridge = {
  [K in keyof ExternalWorkClient]?: NonNullable<ExternalWorkClient[K]> extends (
    ...args: infer A
  ) => Promise<infer R>
    ? (...args: A) => Promise<BridgeResult<R>>
    : never;
};
export const workPath = (item: string) =>
  `/v1/project/work-items/${encodeURIComponent(item)}`;
export const pageQuery = (cursor?: string) =>
  cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
