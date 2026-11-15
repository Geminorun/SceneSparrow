/** The host has no manuscript, renderer, database or generated-code executor. */
export {
  generate,
  discoverModels,
  FakeTransport,
  AiFailure,
} from "@scenesparrow/ai-runtime";
export type {
  RuntimeRequest,
  RuntimeResult,
  ArtifactBroker,
} from "@scenesparrow/ai-runtime";
export const agentCapabilities = {
  generation: true,
  arbitraryCode: false,
} as const;
