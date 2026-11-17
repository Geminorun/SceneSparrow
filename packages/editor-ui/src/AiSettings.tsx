import { useEffect, useState } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "./locales/en.json";
import {
  assignPreset,
  presetProvider,
  servicePresets,
} from "./ai-settings/model";
import { useAiSettings } from "./ai-settings/useAiSettings";
import { DefaultModels } from "./ai-settings/DefaultModels";
import { ServiceDetails } from "./ai-settings/ServiceDetails";
import { OperationStatus } from "./ai-settings/OperationStatus";
import { SettingsModal } from "./ai-settings/SettingsModal";

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
  const c = useAiSettings(client, open, active);
  const [selection, setSelection] = useState("openai");
  const [detail, setDetail] = useState(false);
  const [manage, setManage] = useState(false);
  useEffect(() => {
    if (!open) setManage(false);
  }, [open]);
  const settings = c.view?.settings;
  const preset = servicePresets.find((preset) => preset.id === selection);
  const provider =
    settings &&
    (preset
      ? presetProvider(settings, preset.id)
      : settings.providers.find((provider) => provider.id === selection));
  return (
    <div className="ai-settings" hidden={!active}>
      <OperationStatus
        operation={c.operations.load}
        t={t}
        onReload={() => void c.load()}
      />
      {c.operations.load?.error && (
        <button onClick={() => void c.load()}>{t.aiReload}</button>
      )}
      {!settings ? (
        <p>{t.aiSettingsLoading}</p>
      ) : section === "defaults" ? (
        <DefaultModels controller={c} t={t} />
      ) : (
        <section
          className={`ai-services ${detail ? "ai-show-detail" : ""}`}
          aria-label={t.aiModels}
        >
          <nav className="ai-service-list" aria-label={t.aiModels}>
            <h3>{t.aiModels}</h3>
            {servicePresets.map((preset) => {
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
            {provider && !preset && (
              <button aria-current="page" onClick={() => setDetail(true)}>
                {provider.label}
                <small>{t.aiSavedConfiguration}</small>
              </button>
            )}
            <button
              className="quiet-button ai-manage"
              onClick={() => setManage(true)}
            >
              {t.aiManageConfigurations}
            </button>
          </nav>
          <ServiceDetails
            open={open}
            selection={selection}
            label={preset?.label ?? provider?.label ?? ""}
            provider={provider}
            controller={c}
            t={t}
            onBack={() => setDetail(false)}
          />
        </section>
      )}
      {manage && open && settings && (
        <SettingsModal
          title={t.aiManageConfigurations}
          t={t}
          onClose={() => setManage(false)}
        >
          <p>{t.aiLegacyHint}</p>
          {settings.providers.length === 0 && (
            <p>{t.aiNoSavedConfigurations}</p>
          )}
          {settings.providers.map((provider) => (
            <article className="ai-saved-profile" key={provider.id}>
              <strong>{provider.label}</strong>
              <p>{provider.baseUrl}</p>
              <div className="ai-inline-actions">
                <button
                  onClick={() => {
                    setSelection(provider.id);
                    setDetail(true);
                    setManage(false);
                  }}
                >
                  {t.aiOpenConfiguration}
                </button>
                {servicePresets.map((preset) => (
                  <button
                    key={preset.id}
                    disabled={
                      provider.servicePreset === preset.id ||
                      c.operations[`assign:${provider.id}`]?.busy
                    }
                    onClick={() =>
                      void c.mutate(`assign:${provider.id}`, (settings) =>
                        assignPreset(settings, provider.id, preset.id),
                      )
                    }
                  >
                    {t.aiAssignService.replace("{service}", preset.label)}
                  </button>
                ))}
              </div>
              <OperationStatus
                operation={c.operations[`assign:${provider.id}`]}
                t={t}
                onReload={() => void c.load()}
              />
            </article>
          ))}
        </SettingsModal>
      )}
    </div>
  );
}
