import { useEffect, useState, type ReactNode } from "react";
import type { AiProvider } from "@scenesparrow/contracts";
import type en from "../locales/en.json";
import { modelKey, newModel, validModelId } from "./model";
import { SecretEntry } from "./SecretEntry";
import { ModelDetails } from "./ModelDetails";
import { OperationStatus } from "./OperationStatus";
import { SettingsModal } from "./SettingsModal";
import { savedDiscoveryTarget } from "../notifications";
import type { AiSettingsController } from "./useAiSettings";

export function ServiceDetails({
  selection,
  label,
  provider,
  controller: c,
  t,
  onBack,
  open,
  assignments,
}: {
  selection: string;
  label: string;
  provider: AiProvider | undefined;
  controller: AiSettingsController;
  t: typeof en;
  onBack: () => void;
  open: boolean;
  assignments: ReactNode;
}) {
  const [manuals, setManuals] = useState<Record<string, string>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = useState<string>();
  useEffect(() => {
    if (!open) {
      setPicker(null);
      setManualOpen(false);
    }
  }, [open]);
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const draft = c.providerDraft(selection);
  const dirty = !provider || draft.root !== provider.baseUrl || !!draft.key;
  const operation = c.providerOperation(selection);
  const busy = operation?.busy;
  const added = c.view!.settings.models.filter(
    (model) => model.providerId === provider?.id,
  );
  const keyPresent =
    provider?.credentialRevision &&
    c.view!.presentCredentialRevisions.includes(provider.credentialRevision);
  const editingKey = !keyPresent || !!draft.editingKey || !!draft.key;
  const manual = manuals[selection] ?? "";
  const add = (ids: string[]) =>
    provider &&
    c.mutate(`catalog:${provider.id}`, (settings) => {
      for (const id of ids)
        if (
          !settings.models.some(
            (model) => model.providerId === provider.id && model.id === id,
          )
        )
          settings.models.push(newModel(provider.id, id));
    });
  return (
    <div className="ai-service-detail">
      <button className="quiet-button ai-services-back" onClick={onBack}>
        {t.aiBackServices}
      </button>
      <div className="ai-service-title">
        <span className="ai-service-mark" aria-hidden="true">
          {label[0]}
        </span>
        <h3>{label}</h3>
      </div>
      {assignments}
      <p>
        {c.view!.credentialBackend === "session_only"
          ? t.aiSessionOnly
          : c.view!.credentialBackend === "encrypted_file"
            ? t.aiEncrypted
            : t.aiNative}
      </p>
      {provider?.authMode === "none" ? (
        <p>{t.aiLegacyNoAuth}</p>
      ) : (
        <>
          <p className="ai-key-status" role="status">
            {operation?.credential === "unknown"
              ? t.aiKeyUnknown
              : operation?.credential === "saving"
                ? t.aiKeySaving
                : operation?.credential === "failed"
                  ? t.aiKeyFailed
                  : draft.key
                    ? t.aiKeyEditing
                    : keyPresent
                      ? t.aiKeyPresent
                      : t.aiKeyMissing}
          </p>
          {keyPresent && (
            <div className="ai-saved-key">
              <span className="ai-key-mask" aria-label={t.aiKeyPresent}>
                ••••••••
              </span>
              <span>{t.aiKeySavedLabel}</span>
              <button
                className="quiet-button"
                disabled={busy}
                onClick={() => void c.deleteCredential(provider!.id)}
              >
                {t.aiDeleteKey}
              </button>
              {!editingKey && (
                <button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() =>
                    c.editProvider(selection, {
                      editingKey: true,
                      reveal: false,
                    })
                  }
                >
                  {t.aiReplaceKey}
                </button>
              )}
            </div>
          )}
          {keyPresent && <p className="muted">{t.aiKeyUnverified}</p>}
          {editingKey && (
            <SecretEntry
              id={provider?.id ?? selection}
              value={draft.key}
              revealed={draft.reveal}
              disabled={busy}
              t={t}
              onChange={(key) =>
                c.editProvider(selection, { key, editingKey: true })
              }
              onReveal={() =>
                c.editProvider(selection, { reveal: !draft.reveal })
              }
            />
          )}
          {keyPresent && editingKey && (
            <button
              className="quiet-button"
              disabled={busy}
              onClick={() =>
                c.editProvider(selection, {
                  key: "",
                  reveal: false,
                  editingKey: false,
                })
              }
            >
              {t.aiCancelReplacement}
            </button>
          )}
        </>
      )}
      <label>
        {t.aiRoot}
        <input
          maxLength={8192}
          value={draft.root}
          onChange={(event) =>
            c.editProvider(selection, { root: event.target.value })
          }
        />
      </label>
      <p>{t.aiRootHint}</p>
      <div className="ai-inline-actions">
        {provider?.credentialRevision && !keyPresent && (
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => void c.deleteCredential(provider.id)}
          >
            {t.aiDeleteKey}
          </button>
        )}
        <button
          disabled={!draft.root.trim() || busy}
          onClick={() => void c.saveProvider(selection, provider?.id)}
        >
          {t.aiSaveConfiguration}
        </button>
      </div>
      <OperationStatus operation={c.providerOperation(selection)} t={t} />
      <section className="ai-catalog" aria-label={t.aiAddedModels}>
        <div className="ai-catalog-heading">
          <h4>{t.aiAddedModels}</h4>
          <div className="ai-inline-actions">
            <button
              className="quiet-button"
              disabled={!provider}
              onClick={() => setManualOpen(true)}
            >
              {t.aiAddModel}
            </button>
            <button
              className="quiet-button"
              disabled={
                !provider ||
                dirty ||
                c.operations[`discovery:${provider?.id}`]?.busy
              }
              onClick={() => {
                setPicker(provider!.id);
                setPickerTarget(savedDiscoveryTarget(provider!.baseUrl));
                setSearch("");
                setChoices([]);
                void c.discover(provider!.id);
              }}
            >
              {t.aiDiscover}
            </button>
          </div>
        </div>
        {!provider && <p>{t.aiSaveServiceFirst}</p>}
        <p>{t.aiDiscoveryHint}</p>
        {provider && (
          <p className="ai-discovery-target">
            {t.aiDiscoveryTarget}:{" "}
            <code>{savedDiscoveryTarget(provider.baseUrl)}</code>
          </p>
        )}
        <OperationStatus
          operation={c.operations[`catalog:${provider?.id}`]}
          t={t}
        />
        {added.length === 0 && <p className="ai-empty">{t.aiNoModels}</p>}
        {added.map((model) => (
          <ModelDetails
            key={modelKey(model.providerId, model.id)}
            model={model}
            controller={c}
            t={t}
            providerDirty={dirty}
          />
        ))}
      </section>
      {manualOpen && open && (
        <SettingsModal
          title={t.aiAddModel}
          t={t}
          onClose={() => setManualOpen(false)}
        >
          {" "}
          <div className="ai-manual-model">
            <label>
              {t.aiModel}
              <input
                maxLength={256}
                value={manual}
                onChange={(event) =>
                  setManuals((state) => ({
                    ...state,
                    [selection]: event.target.value,
                  }))
                }
              />
            </label>
            <button
              disabled={
                !provider ||
                !validModelId(manual.trim()) ||
                added.some((model) => model.id === manual.trim()) ||
                c.operations[`catalog:${provider?.id}`]?.busy
              }
              onClick={() =>
                void add([manual.trim()])?.then((saved) => {
                  if (saved) setManualOpen(false);
                })
              }
            >
              {t.aiAddModel}
            </button>
          </div>
          {manual.trim() && !validModelId(manual.trim()) && (
            <p role="alert">{t.aiInvalidModelId}</p>
          )}
          <OperationStatus
            operation={c.operations[`catalog:${provider?.id}`]}
            t={t}
          />
        </SettingsModal>
      )}
      {picker && open && (
        <SettingsModal
          title={t.aiDiscover}
          t={t}
          onClose={() => setPicker(null)}
        >
          <p>{t.aiDiscoveryHint}</p>
          <p className="ai-discovery-target">
            {t.aiDiscoveryTarget}: <code>{pickerTarget}</code>
          </p>
          <button
            className="quiet-button"
            onClick={() => {
              setPicker(null);
              setManualOpen(true);
            }}
          >
            {t.aiAddModel}
          </button>
          <label>
            {t.aiSearchModels}
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <OperationStatus
            operation={c.operations[`discovery:${picker}`]}
            t={t}
          />
          {c.operations[`discovery:${picker}`]?.error && (
            <button
              className="quiet-button"
              disabled={c.operations[`discovery:${picker}`]?.busy}
              onClick={() => void c.discover(picker)}
            >
              {t.retry}
            </button>
          )}
          <div className="ai-discovery-list">
            {(c.catalogs[picker] ?? [])
              .filter((id) =>
                id.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
              )
              .map((id) => {
                const exists = c.view!.settings.models.some(
                  (model) => model.providerId === picker && model.id === id,
                );
                return (
                  <label className="ai-checkbox" key={id}>
                    <input
                      type="checkbox"
                      disabled={exists}
                      checked={exists || choices.includes(id)}
                      onChange={(event) =>
                        setChoices((choices) =>
                          event.target.checked
                            ? [...choices, id]
                            : choices.filter((choice) => choice !== id),
                        )
                      }
                    />
                    {id}
                    {exists && <small>{t.aiAlreadyAdded}</small>}
                  </label>
                );
              })}
          </div>
          <button
            disabled={
              !choices.length || c.operations[`catalog:${picker}`]?.busy
            }
            onClick={() => {
              const selected = [...choices];
              void c.mutate(`catalog:${picker}`, (settings) => {
                for (const id of selected)
                  if (
                    !settings.models.some(
                      (model) => model.providerId === picker && model.id === id,
                    )
                  )
                    settings.models.push(newModel(picker, id));
              });
            }}
          >
            {t.aiAddSelected}
          </button>
          <OperationStatus
            operation={c.operations[`catalog:${picker}`]}
            t={t}
          />
        </SettingsModal>
      )}
    </div>
  );
}
