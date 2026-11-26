import { useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import {
  assignPreset,
  presetProvider,
  servicePresets,
  isOfficialDeepseekProvider,
} from "./model";
import { useAiSettings, type AiSettingsController } from "./useAiSettings";
import { DefaultModels } from "./DefaultModels";
import { ServiceDetails } from "./ServiceDetails";
import { OperationStatus } from "./OperationStatus";

export function AiSettings({
  client,
  t,
  active,
  open,
  section,
}: {
  client: PlatformClient;
  t: typeof en;
  active: boolean;
  open: boolean;
  section: "services" | "defaults";
}) {
  const controller = useAiSettings(client, open, active);
  return (
    <AiSettingsContent
      controller={controller}
      t={t}
      active={active}
      open={open}
      section={section}
    />
  );
}

export function AiSettingsContent({
  controller: c,
  t,
  active,
  open,
  section,
  directOnly = false,
}: {
  controller: AiSettingsController;
  t: typeof en;
  active: boolean;
  open: boolean;
  section: "services" | "defaults";
  directOnly?: boolean;
}) {
  const [selected, setSelection] = useState("openai");
  const [detail, setDetail] = useState(false);
  const savedSettings = c.view?.settings;
  const selection =
    directOnly &&
    savedSettings?.providers.some(
      (p) => p.id === selected && isOfficialDeepseekProvider(p),
    )
      ? "openai"
      : selected;
  const settings =
    savedSettings && directOnly
      ? {
          ...savedSettings,
          providers: savedSettings.providers.filter(
            (p) => !isOfficialDeepseekProvider(p),
          ),
        }
      : savedSettings;
  const presets = directOnly
    ? servicePresets.filter((p) => p.id !== "deepseek")
    : servicePresets;
  const preset = presets.find((preset) => preset.id === selection);
  const provider =
    settings &&
    (preset
      ? presetProvider(settings, preset.id)
      : settings.providers.find((provider) => provider.id === selection));
  const selectedSavedProvider =
    savedSettings &&
    (preset
      ? presetProvider(savedSettings, preset.id)
      : savedSettings.providers.find((p) => p.id === selection));
  const showDetails =
    !directOnly ||
    !selectedSavedProvider ||
    !isOfficialDeepseekProvider(selectedSavedProvider);
  return (
    <div className="ai-settings" hidden={!active}>
      <OperationStatus operation={c.operations.load} t={t} />
      {(c.operations.load?.error ||
        Object.values(c.conflicts).some(Boolean) ||
        Object.values(c.operations).some(
          (operation) => operation.error === "SETTINGS_CONFLICT",
        )) && (
        <button className="quiet-button" onClick={() => void c.load()}>
          {t.retry}
        </button>
      )}
      {!settings ? (
        !c.operations.load?.error && <p>{t.aiSettingsLoading}</p>
      ) : section === "defaults" ? (
        <DefaultModels controller={c} t={t} directOnly={directOnly} />
      ) : (
        <section
          className={`ai-services ${detail ? "ai-show-detail" : ""}`}
          aria-label={t.aiModels}
        >
          <nav className="ai-service-list" aria-label={t.aiModels}>
            <h3>{t.aiModels}</h3>
            {presets.map((preset) => {
              const profile = presetProvider(settings, preset.id);
              return (
                <button
                  key={preset.id}
                  aria-current={selection === preset.id ? "page" : undefined}
                  onClick={() => {
                    setSelection(preset.id);
                    setDetail(true);
                  }}
                >
                  <span className="ai-service-mark" aria-hidden="true">
                    {preset.label[0]}
                  </span>
                  <span>
                    {preset.label}
                    <small>
                      {profile ? t.aiConfigured : t.aiNotConfigured}
                    </small>
                  </span>
                </button>
              );
            })}
            {settings.providers
              .filter(
                (profile) =>
                  !presets.some(
                    (service) =>
                      presetProvider(settings, service.id)?.id === profile.id,
                  ),
              )
              .map((profile) => (
                <button
                  key={profile.id}
                  aria-current={selection === profile.id ? "page" : undefined}
                  onClick={() => {
                    setSelection(profile.id);
                    setDetail(true);
                  }}
                >
                  <span className="ai-service-mark" aria-hidden="true">
                    {profile.label[0]}
                  </span>
                  <span>
                    {profile.label}
                    <small>{t.aiSavedConfiguration}</small>
                  </span>
                </button>
              ))}
          </nav>
          {showDetails && (
            <ServiceDetails
              open={open}
              selection={selection}
              label={preset?.label ?? provider?.label ?? ""}
              provider={provider}
              controller={c}
              t={t}
              onBack={() => setDetail(false)}
              assignments={
                provider && (
                  <details className="ai-service-assignment">
                    <summary>{t.aiServiceAssignment}</summary>
                    <div className="ai-inline-actions">
                      {presets.map((service) => (
                        <button
                          key={service.id}
                          disabled={
                            provider.servicePreset === service.id ||
                            c.operations[`assign:${provider.id}`]?.busy
                          }
                          onClick={() =>
                            void c.mutate(`assign:${provider.id}`, (settings) =>
                              assignPreset(settings, provider.id, service.id),
                            )
                          }
                        >
                          {t.aiAssignService.replace(
                            "{service}",
                            service.label,
                          )}
                        </button>
                      ))}
                    </div>
                  </details>
                )
              }
            />
          )}
        </section>
      )}
    </div>
  );
}
