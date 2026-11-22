import type en from "../locales/en.json";
/** Workspace slots stay separate from the core manuscript stage. */
export function WorkspaceRibbon({
  t,
  onWrite,
}: {
  t: typeof en;
  onWrite?: () => void;
}) {
  return (
    <nav className="workspace-ribbon" aria-label={t.workbench}>
      <span className="ribbon-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="25" height="25">
          <path
            d="M4 23c7-1 9-8 12-15 0 5 1 8 5 9l7-2-5 6c-6 5-11 7-19 2Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <button
        aria-label={t.workspaceWrite}
        aria-current="page"
        title={t.workspaceWrite}
        onClick={
          onWrite ??
          (() => document.querySelector<HTMLElement>(".tiptap")?.focus())
        }
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M6 3h9l4 4v14H6zM9 11h7M9 15h7M9 18h4M14 3v5h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </button>
    </nav>
  );
}
