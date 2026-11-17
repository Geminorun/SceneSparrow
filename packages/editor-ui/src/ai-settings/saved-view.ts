import { useSyncExternalStore } from "react";
import type { AiSettingsView } from "@scenesparrow/contracts";
let view: AiSettingsView | null = null;
const listeners = new Set<() => void>();
export function publishSavedAiView(next: AiSettingsView) {
  view = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
// This summary subscribes only to explicitly loaded settings. It initiates no reads.
export const useSavedAiView = () => useSyncExternalStore(subscribe, () => view);
