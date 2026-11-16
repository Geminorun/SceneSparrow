export interface ProjectActivationPorts {
  stop(): Promise<void>;
  start(directory: string): Promise<void>;
}
/** A failed candidate activation always attempts to restore the previous owner. */
export async function activateProject(
  previous: string,
  candidate: string,
  ports: ProjectActivationPorts,
) {
  await ports.stop();
  try {
    await ports.start(candidate);
    return { directory: candidate, changed: true };
  } catch {
    await ports.stop().catch(() => {});
    try {
      await ports.start(previous);
    } catch {
      throw Error("PROJECT_REOPEN_FAILED");
    }
    return { directory: previous, changed: false };
  }
}
