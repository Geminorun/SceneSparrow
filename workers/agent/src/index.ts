export interface AgentTask {
  id: string;
  attempt: number;
  inputSnapshot: string;
  allowedObjectIds: readonly string[];
}

export interface AgentProposal {
  taskId: string;
  attempt: number;
  inputSnapshot: string;
  artifactIds: readonly string[];
}

export interface AgentProvider {
  start(
    task: AgentTask,
    signal: AbortSignal,
  ): AsyncIterable<{ message: string }>;
  cancel(taskId: string): Promise<void>;
  collectResult(taskId: string): Promise<AgentProposal>;
}

// No provider or arbitrary-code executor is enabled in the foundation.
export const agentCapabilities = {
  generation: false,
  arbitraryCode: false,
} as const;
