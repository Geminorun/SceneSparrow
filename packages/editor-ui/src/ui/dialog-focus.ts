type TabEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "defaultPrevented" | "preventDefault"
>;

export function trapDialogFocus(event: TabEvent, dialog: HTMLDialogElement) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (
      element.closest("dialog") !== dialog ||
      element.matches(":disabled") ||
      element.tabIndex < 0 ||
      element.closest("[inert], [hidden]") ||
      !element.getClientRects().length
    )
      return false;
    // Inspect only this control's ancestors, including closed model details.
    for (
      let details = element.closest("details:not([open])");
      details;
      details = details.parentElement?.closest("details:not([open])") ?? null
    ) {
      if (element !== details.querySelector(":scope > summary")) return false;
    }
    return true;
  });
  const first = controls[0],
    last = controls.at(-1);
  if (
    first &&
    last &&
    ((event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last))
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
