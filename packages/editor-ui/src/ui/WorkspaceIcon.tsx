const paths = {
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  panelLeft: "M4 4h16v16H4zM9 4v16",
  panelRight: "M4 4h16v16H4zM15 4v16",
  close: "m6 6 12 12M6 18 18 6",
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
