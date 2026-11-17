import type { AiEvidence, AiModel } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import {
  bindText,
  modelKey,
  modelParameters,
  savedTargetSignature,
  saveModel,
  unknownEvidence,
} from "./model";
import type { AiSettingsController } from "./useAiSettings";
import { OperationStatus } from "./OperationStatus";

export function ModelDetails({
  model,
  controller: c,
  t,
  providerDirty,
}: {
  model: AiModel;
  controller: AiSettingsController;
  t: typeof en;
  providerDirty: boolean;
}) {
  const settings = c.view!.settings;
  const id = modelKey(model.providerId, model.id);
  const saved = {
    ...model,
    defaultParameters: modelParameters(settings, model),
  };
  const draft = c.models[id] ?? saved;
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const edit = (patch: Partial<AiModel>) => {
    c.invalidateTests(model.providerId, model.id);
    c.setModels((models) => ({ ...models, [id]: { ...draft, ...patch } }));
  };
  const parameters = draft.defaultParameters!;
  const binding = settings.bindings.find(
    (binding) => binding.category === "text",
  );
  const bound =
    binding?.providerId === model.providerId && binding?.modelId === model.id;
  const anyBound = settings.bindings.some(
    (binding) =>
      binding.providerId === model.providerId && binding.modelId === model.id,
  );
  const test = c.tests[id];
  const validTest =
    !dirty &&
    !providerDirty &&
    !test?.invalidated &&
    test?.action.sessionId === c.view!.sessionId &&
    test?.signature === savedTargetSignature(settings, model)
      ? test
      : undefined;
  const busy = c.operations[`model:${id}`]?.busy;
  const testBusy = c.operations[`test:${id}`]?.busy;
  return (
    <article className="ai-model-row">
      <div className="ai-model-heading">
        <span>
          <strong>{model.label || model.id}</strong>
          {model.label !== model.id && <small>{model.id}</small>}
          {bound && (
            <small className="ai-default-badge">{t.aiManuscriptDefault}</small>
          )}
        </span>
        <button
          className="quiet-button"
          disabled={bound || busy}
          onClick={() =>
            void c.mutate(`model:${id}`, (settings) =>
              bindText(
                settings,
                settings.models.find(
                  (m) => modelKey(m.providerId, m.id) === id,
                ),
              ),
            )
          }
        >
          {t.aiBindText}
        </button>
      </div>
      <details className="ai-model-detail">
        <summary>{t.aiModelDetails}</summary>
        <p>
          {t.aiTestTarget
            .replace(
              "{provider}",
              settings.providers.find(
                (provider) => provider.id === model.providerId,
              )?.label ?? "",
            )
            .replace("{model}", model.id)
            .replace(
              "{root}",
              settings.providers.find(
                (provider) => provider.id === model.providerId,
              )?.baseUrl ?? "",
            )}
        </p>
        <p>{t.aiTestQuota}</p>
        {(dirty || providerDirty) && <p>{t.aiSaveBeforeTest}</p>}
        <div className="ai-inline-actions">
          <button
            disabled={dirty || providerDirty || testBusy || busy}
            onClick={() => void c.testModel(model)}
          >
            {t.aiTest}
          </button>
          {validTest && !validTest.receipt && (
            <button
              disabled={testBusy}
              onClick={() => void c.testModel(model, true)}
            >
              {t.aiTestStatus}
            </button>
          )}
        </div>
        <OperationStatus operation={c.operations[`test:${id}`]} t={t} />
        {validTest?.receipt && (
          <>
            <p>
              {t.aiTestResultTarget
                .replace("{model}", validTest.receipt.target.modelId)
                .replace("{root}", validTest.receipt.providerRoot ?? "")}
            </p>
            <p role="status">
              {validTest.receipt.status === "succeeded"
                ? t.aiTestSuccess
                : t.aiTestFailed}
            </p>
          </>
        )}
        <details className="ai-advanced">
          <summary>{t.aiAdvanced}</summary>
          <div>
            {(
              [
                ["images", t.aiImages],
                ["streaming", t.aiStreaming],
                ["nativeJson", t.aiNativeJson],
              ] as const
            ).map(([capability, label]) => (
              <label key={capability}>
                {label}
                <select
                  value={draft.capabilities[capability].state}
                  onChange={(event) => {
                    const state = event.target.value as AiEvidence["state"];
                    edit({
                      capabilities: {
                        ...draft.capabilities,
                        [capability]:
                          state === "unknown"
                            ? unknownEvidence()
                            : {
                                state,
                                source: "user",
                                scope: "User compatibility declaration",
                                observedAt: new Date().toISOString(),
                              },
                      },
                    });
                  }}
                >
                  <option value="unknown">{t.aiUnknown}</option>
                  <option value="supported">{t.aiDeclaredSupported}</option>
                  <option value="unsupported">{t.aiDeclaredUnsupported}</option>
                </select>
              </label>
            ))}
            <label>
              {t.aiContextLimit}
              <input
                type="number"
                min={1}
                max={10000000}
                value={draft.contextTokens ?? ""}
                onChange={(event) =>
                  edit({
                    contextTokens:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              {t.aiOutputLimit}
              <input
                type="number"
                min={16}
                max={1000000}
                value={draft.outputTokens ?? ""}
                onChange={(event) =>
                  edit({
                    outputTokens:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              {t.aiTokens}
              <input
                type="number"
                min={16}
                max={draft.outputTokens ?? 1000000}
                value={parameters.maxOutputTokens}
                onChange={(event) =>
                  edit({
                    defaultParameters: {
                      ...parameters,
                      maxOutputTokens: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              {t.aiTokenField}
              <select
                value={draft.tokenField}
                onChange={(event) =>
                  edit({
                    tokenField: event.target.value as AiModel["tokenField"],
                  })
                }
              >
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">
                  max_completion_tokens
                </option>
              </select>
            </label>
            <label>
              {t.aiTemperature}
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={
                  parameters.temperatureMilli === null
                    ? ""
                    : parameters.temperatureMilli / 1000
                }
                onChange={(event) =>
                  edit({
                    defaultParameters: {
                      ...parameters,
                      temperatureMilli:
                        event.target.value === ""
                          ? null
                          : Math.round(Number(event.target.value) * 1000),
                    },
                  })
                }
              />
            </label>
            <label className="ai-checkbox">
              <input
                type="checkbox"
                checked={parameters.requestStreaming}
                disabled={
                  draft.capabilities.streaming.state !== "supported" &&
                  !parameters.requestStreaming
                }
                onChange={(event) =>
                  edit({
                    defaultParameters: {
                      ...parameters,
                      requestStreaming: event.target.checked,
                    },
                  })
                }
              />
              {t.aiRequestStreaming}
            </label>
            <label className="ai-checkbox">
              <input
                type="checkbox"
                checked={parameters.requestNativeJson}
                disabled={
                  draft.capabilities.nativeJson.state !== "supported" &&
                  !parameters.requestNativeJson
                }
                onChange={(event) =>
                  edit({
                    defaultParameters: {
                      ...parameters,
                      requestNativeJson: event.target.checked,
                    },
                  })
                }
              />
              {t.aiRequestNativeJson}
            </label>
          </div>
          <button
            disabled={!dirty || busy}
            onClick={() =>
              void c.mutate(`model:${id}`, (settings) =>
                saveModel(settings, draft),
              )
            }
          >
            {t.aiSaveModel}
          </button>
        </details>
        <button
          className="quiet-button"
          disabled={anyBound || busy}
          onClick={() =>
            void c.mutate(`model:${id}`, (settings) => {
              settings.models = settings.models.filter(
                (model) => modelKey(model.providerId, model.id) !== id,
              );
            })
          }
        >
          {t.aiRemoveModel}
        </button>
        {anyBound && <p>{t.aiBoundRemoval}</p>}
      </details>
      <OperationStatus operation={c.operations[`model:${id}`]} t={t} />
    </article>
  );
}
