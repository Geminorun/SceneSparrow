import type en from "../locales/en.json";
export function OperationStatus({
  operation,
  t,
  onReload,
}: {
  operation: { busy?: boolean; error?: string; message?: string } | undefined;
  t: typeof en;
  onReload?: () => void;
}) {
  if (!operation) return null;
  return (
    <>
      {operation.busy && <p role="status">{t.aiWorking}</p>}
      {operation.message && (
        <p role="status">
          {operation.message === "partial"
            ? t.aiPartialSave
            : t.aiConfigurationSaved}
        </p>
      )}
      {operation.error && (
        <p role="alert">
          {t[operation.error as keyof typeof en] ?? t.AI_ERROR}
          {operation.error === "SETTINGS_CONFLICT" && onReload && (
            <button onClick={onReload}>{t.aiReload}</button>
          )}
        </p>
      )}
    </>
  );
}
