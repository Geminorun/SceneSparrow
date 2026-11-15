import type { ChildProcess } from "node:child_process";
/** A signal exit is terminal even though Node leaves exitCode null. */
export function coreIsRunning(
  child: ChildProcess | undefined | null,
): child is ChildProcess {
  return (
    !!child &&
    Number.isInteger(child.pid) &&
    child.exitCode === null &&
    child.signalCode === null
  );
}
export async function stopCoreProcess(
  child: ChildProcess | undefined | null,
): Promise<void> {
  if (!coreIsRunning(child)) return;
  await new Promise<void>((done) => {
    child.once("exit", () => done());
    // Listener registration precedes signalling; an already signalled child was
    // rejected above, so no missed exit event can strand lifecycle rollback.
    child.kill();
  });
}
