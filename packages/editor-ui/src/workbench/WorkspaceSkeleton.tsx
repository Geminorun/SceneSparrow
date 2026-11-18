import type en from "../locales/en.json";
import { WorkspacePane, useAuxiliaryPane } from "./WorkspacePane";

/** Match the editor geometry without mounting a writable or invented document. */
export function WorkspaceSkeleton({
  t,
  busy = true,
  onRetry,
}: {
  t: typeof en;
  busy?: boolean;
  onRetry?: () => void;
}) {
  const pane = useAuxiliaryPane();
  const lines = (
    <div className="skeleton-lines" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
  return (
    <section
      className="manuscript-workspace workspace-skeleton"
      aria-busy={busy}
      aria-label={t.workspaceLoading}
      data-testid="workspace-skeleton"
    >
      {!busy && onRetry && (
        <button className="quiet-button skeleton-retry" onClick={onRetry}>
          {t.retry}
        </button>
      )}
      <div inert>
        <WorkspacePane
          pane={pane}
          t={t}
          panels={{
            structure: lines,
            sources: lines,
            planning: lines,
            review: lines,
          }}
        >
          <div className="manuscript-header">
            <div className="skeleton-heading" aria-hidden="true" />
          </div>
          <div className="document-layout">
            <div className="skeleton-document" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
        </WorkspacePane>
      </div>
    </section>
  );
}
