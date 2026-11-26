import type en from "../locales/en.json";
import { bindText, modelKey, isOfficialDeepseekProvider } from "./model";
import { OperationStatus } from "./OperationStatus";
import type { AiSettingsController } from "./useAiSettings";
export function DefaultModels({
  controller: c,
  t,
  directOnly = false,
}: {
  controller: AiSettingsController;
  t: typeof en;
  directOnly?: boolean;
}) {
  const settings = c.view!.settings;
  const binding = settings.bindings.find(
    (binding) => binding.category === "text",
  );
  const harnessBound =
    directOnly &&
    settings.providers.some(
      (p) => p.id === binding?.providerId && isOfficialDeepseekProvider(p),
    );
  return (
    <section className="ai-default-models" aria-label={t.aiDefaultModels}>
      <h3>{t.aiDefaultModels}</h3>
      <p>{t.aiGlobal}</p>
      <label>
        {t.aiManuscriptModel}
        <select
          aria-label={t.aiManuscriptModel}
          value={
            harnessBound
              ? "harness"
              : binding
                ? modelKey(binding.providerId, binding.modelId)
                : ""
          }
          disabled={c.operations.defaults?.busy}
          onChange={(event) => {
            const value = event.target.value;
            void c.mutate("defaults", (settings) =>
              bindText(
                settings,
                settings.models.find(
                  (model) => modelKey(model.providerId, model.id) === value,
                ),
              ),
            );
          }}
        >
          {harnessBound && (
            <option value="harness" disabled>
              {t.deepseekWritingActive}
            </option>
          )}
          <option value="">{t.aiNoDefault}</option>
          {settings.providers
            .filter(
              (provider) =>
                (!directOnly || !isOfficialDeepseekProvider(provider)) &&
                settings.models.some(
                  (model) => model.providerId === provider.id,
                ),
            )
            .map((provider) => (
              <optgroup key={provider.id} label={provider.label}>
                {settings.models
                  .filter((model) => model.providerId === provider.id)
                  .map((model) => (
                    <option
                      key={model.id}
                      value={modelKey(provider.id, model.id)}
                    >
                      {model.label || model.id}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </label>
      <p>{t.aiFutureTasks}</p>
      <OperationStatus operation={c.operations.defaults} t={t} />
    </section>
  );
}
