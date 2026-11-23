import type { FinalizationState } from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";

export type TrackLocalLock = (
  projectId: string,
  requestId: string,
) => (confirmed?: FinalizationState) => void;

export function localLockEvents(
  client: PlatformClient,
  apply: (projectId: string, state: FinalizationState) => void,
): { client: PlatformClient; track: TrackLocalLock } {
  const commands = new Map<
    string,
    { projectId: string; handled: Promise<boolean> }
  >();
  return {
    client: {
      ...client,
      subscribeEvents(handler, resync) {
        let active = true;
        const stop = client.subscribeEvents((event) => {
          const command = event.requestId
            ? commands.get(event.requestId)
            : undefined;
          if (
            command?.projectId === event.projectId &&
            [
              "manuscript.changed",
              "manuscript.readinessChanged",
              "locks.changed",
              "history.changed",
            ].includes(event.type)
          ) {
            void command.handled
              .then((handled) => {
                if (active && !handled) handler(event);
              })
              .catch(() => {});
          } else handler(event);
        }, resync);
        return () => {
          active = false;
          stop();
        };
      },
    },
    track(projectId, requestId) {
      let settle!: (handled: boolean) => void;
      const handled = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      commands.set(requestId, { projectId, handled });
      // Keep recent acknowledgments for late or replayed events on this client.
      if (commands.size > 64) commands.delete(commands.keys().next().value!);
      return (confirmed) => {
        if (confirmed) apply(projectId, confirmed);
        else commands.delete(requestId);
        settle(!!confirmed);
      };
    },
  };
}
