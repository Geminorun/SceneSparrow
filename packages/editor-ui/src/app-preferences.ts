export type SaveMode = "after_delay" | "on_window_change" | "off";
export type SaveDelay = 5 | 10 | 30;
export type ApplicationPreferences = {
  version: 1;
  saveMode: SaveMode;
  saveDelaySeconds: SaveDelay;
};
export const preferencesKey = "scenesparrow.application-preferences";
export const defaultPreferences: ApplicationPreferences = {
  version: 1,
  saveMode: "after_delay",
  saveDelaySeconds: 10,
};
function validate(value: unknown): ApplicationPreferences {
  const p = value as Partial<ApplicationPreferences> | null;
  if (!p || p.version !== 1) return { ...defaultPreferences };
  return {
    version: 1,
    saveMode: ["after_delay", "on_window_change", "off"].includes(
      p.saveMode ?? "",
    )
      ? p.saveMode!
      : defaultPreferences.saveMode,
    saveDelaySeconds: [5, 10, 30].includes(p.saveDelaySeconds ?? 0)
      ? p.saveDelaySeconds!
      : defaultPreferences.saveDelaySeconds,
  };
}
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export class ApplicationPreferencesStore {
  private value: ApplicationPreferences = { ...defaultPreferences };
  private listeners = new Set<() => void>();
  private storage: PreferenceStorage | undefined;
  constructor(
    storage: () => PreferenceStorage | undefined = () =>
      typeof window === "undefined" ? undefined : window.localStorage,
    events: Pick<Window, "addEventListener"> | undefined = typeof window ===
    "undefined"
      ? undefined
      : window,
  ) {
    try {
      this.storage = storage();
      this.value = validate(
        JSON.parse(this.storage?.getItem(preferencesKey) ?? "null"),
      );
    } catch {
      // Editing remains available in profiles that deny renderer storage.
    }
    events?.addEventListener("storage", (event) => {
      if (event.key !== preferencesKey && event.key !== null) return;
      if (event.storageArea && event.storageArea !== this.storage) return;
      try {
        this.publish(validate(JSON.parse(event.newValue ?? "null")));
      } catch {
        this.publish({ ...defaultPreferences });
      }
    });
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(
    patch: Partial<
      Pick<ApplicationPreferences, "saveMode" | "saveDelaySeconds">
    >,
  ) {
    const next = validate({ ...this.value, ...patch });
    try {
      this.storage?.setItem(preferencesKey, JSON.stringify(next));
    } catch {
      // Keep this session's selection even when persistence is unavailable.
    }
    this.publish(next);
  }
  private publish(next: ApplicationPreferences) {
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  }
}
// The native renderer uses a stable file URL in Electron's persistent userData
// session. This nonsecret store is shared by projects, independently of AI config.
export const applicationPreferences = new ApplicationPreferencesStore();
