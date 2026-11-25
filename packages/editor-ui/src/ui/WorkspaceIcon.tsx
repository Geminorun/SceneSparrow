const paths = {
  comment: "M4 4h16v12H9l-5 4z",
  lock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v3",
  unlock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 7.5-2M12 14v3",
  menu: "M5 12h.01M12 12h.01M19 12h.01",
  copy: "M8 8h12v12H8zM16 4H4v12",
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
