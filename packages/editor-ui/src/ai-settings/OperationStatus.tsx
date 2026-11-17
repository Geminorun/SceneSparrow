import type en from "../locales/en.json";
export function OperationStatus({
  operation,
  t,
}: {
  operation: { busy?: boolean; error?: string; message?: string } | undefined;
  t: typeof en;
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
    </>
  );
}
