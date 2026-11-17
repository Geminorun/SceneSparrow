import type {
  AiEvidence,
  AiModel,
  AiParameters,
  AiProvider,
  AiSettings,
} from "@scenesparrow/contracts";

export const servicePresets = [
  { id: "openai", label: "OpenAI", root: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", root: "https://api.deepseek.com/v1" },
] as const;
export type ServicePreset = (typeof servicePresets)[number]["id"];
export type ProviderDraft = {
  root: string;
  key: string;
  reveal: boolean;
  editingKey?: boolean;
};
export const modelKey = (providerId: string, id: string) =>
  JSON.stringify([providerId, id]);
export const unknownEvidence = (): AiEvidence => ({
  state: "unknown",
  source: "unknown",
  scope: "",
  observedAt: null,
});

// Recognition is presentation only. Proxies and ambiguous duplicate profiles stay saved configurations.
export function presetProvider(
  settings: AiSettings,
  preset: ServicePreset,
): AiProvider | undefined {
  const assigned = settings.providers.find(
    (provider) => provider.servicePreset === preset,
  );
  if (assigned) return assigned;
  const root = servicePresets.find((service) => service.id === preset)!.root;
  const candidates = settings.providers.filter(
    (provider) =>
      !provider.servicePreset && provider.baseUrl.replace(/\/$/, "") === root,
  );
  const bound = settings.bindings.find(
    (binding) => binding.category === "text",
  );
  return (
    candidates.find((provider) => provider.id === bound?.providerId) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}
export function modelParameters(
  settings: AiSettings,
  model: AiModel,
): AiParameters {
  return structuredClone(
    model.defaultParameters ??
      (
        settings.bindings.find(
          (binding) =>
            binding.category === "text" &&
            binding.providerId === model.providerId &&
            binding.modelId === model.id,
        ) ??
        settings.bindings.find(
          (binding) =>
            binding.providerId === model.providerId &&
            binding.modelId === model.id,
        )
      )?.parameters ?? {
        temperatureMilli: null,
        maxOutputTokens: Math.min(
          4096,
          model.outputTokens ?? 4096,
          model.contextTokens ?? 4096,
        ),
        requestStreaming: false,
        requestNativeJson: false,
      },
  );
}
export function validModelId(id: string) {
  return (
    !!id.trim() &&
    new TextEncoder().encode(id).length <= 256 &&
    !/\p{Cc}/u.test(id)
  );
}
export function modelLabel(id: string) {
  let label = "";
  for (const character of id) {
    if (new TextEncoder().encode(label + character).length > 120) break;
    label += character;
  }
  return label;
}
export function newModel(
  providerId: string,
  id: string,
  limits: Pick<AiModel, "contextTokens" | "outputTokens"> = {
    contextTokens: null,
    outputTokens: null,
  },
): AiModel {
  return {
    providerId,
    id,
    label: modelLabel(id),
    capabilities: {
      images: unknownEvidence(),
      streaming: unknownEvidence(),
      nativeJson: unknownEvidence(),
    },
    contextTokens: limits.contextTokens,
    outputTokens: limits.outputTokens,
    tokenField: "max_tokens",
    defaultParameters: {
      temperatureMilli: null,
      maxOutputTokens: Math.min(
        8192,
        limits.outputTokens ?? 8192,
        limits.contextTokens ?? 8192,
      ),
      requestStreaming: false,
      requestNativeJson: false,
    },
  };
}
export function bindText(settings: AiSettings, model?: AiModel) {
  const previous = settings.bindings.find(
    (binding) => binding.category === "text",
  );
  const parameters = model && modelParameters(settings, model);
  settings.bindings = settings.bindings.filter(
    (binding) => binding.category !== "text",
  );
  if (model)
    settings.bindings.push({
      category: "text",
      providerId: model.providerId,
      modelId: model.id,
      parameters: parameters!,
      revision: previous?.revision ?? 1,
    });
}
export function saveModel(settings: AiSettings, draft: AiModel) {
  settings.models = settings.models.map((model) =>
    modelKey(model.providerId, model.id) ===
    modelKey(draft.providerId, draft.id)
      ? structuredClone(draft)
      : model,
  );
  const binding = settings.bindings.find(
    (binding) =>
      binding.category === "text" &&
      binding.providerId === draft.providerId &&
      binding.modelId === draft.id,
  );
  if (binding && draft.defaultParameters)
    binding.parameters = structuredClone(draft.defaultParameters);
}
export function assignPreset(
  settings: AiSettings,
  providerId: string,
  preset: ServicePreset,
) {
  for (const provider of settings.providers) {
    if (provider.servicePreset === preset) delete provider.servicePreset;
    if (provider.id === providerId) provider.servicePreset = preset;
  }
}
export function savedTargetSignature(settings: AiSettings, model: AiModel) {
  const provider = settings.providers.find(
    (provider) => provider.id === model.providerId,
  );
  return JSON.stringify([
    provider?.baseUrl,
    provider?.authMode,
    provider?.credentialRevision,
    model,
  ]);
}
