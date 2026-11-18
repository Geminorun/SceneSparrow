import type {
  HistoryErrorDetails,
  ManuscriptCommand,
} from "@scenesparrow/contracts";
import type { ProjectSession } from "./project-session";
/** Own exact command identities across uncertain responses, independently of UI
 * render generations. Resolving an older action never evaluates a new builder. */
type CommandOutcome = {
  ok: boolean;
  completed: ManuscriptCommand | null;
  error: string;
  details: HistoryErrorDetails | undefined;
};
export class ProjectCommands {
  private flight: {
    identity: string;
    promise: Promise<CommandOutcome>;
  } | null = null;
  private pending: {
    command: ManuscriptCommand;
    identity: string;
    visible: string;
  } | null = null;
  constructor(private readonly save: ProjectSession) {}
  run(
    identity: string,
    build: (revision: number) => ManuscriptCommand,
    options?: {
      validIntent?: () => boolean;
      requestedVisible?: string;
      dispatched?: () => void;
    },
  ): Promise<CommandOutcome> {
    const independent =
      identity.startsWith("CancelReviewTask:") ||
      identity.startsWith("CancelPlanningTask:") ||
      (identity.startsWith("lock:") && identity.endsWith(":false"));
    if (this.save.composing && !independent) {
      return this.save.actions
        .run(
          `review-command:${identity}`,
          () => this.run(identity, build, options),
          () => !options?.validIntent || options.validIntent(),
        )
        .then(
          (result) =>
            result || {
              ok: false,
              completed: null,
              error: "CANCELLED",
              details: undefined,
            },
        );
    }
    if (this.flight) {
      return this.flight.identity === identity
        ? this.flight.promise
        : this.flight.promise.then((result) => ({ ...result, ok: false }));
    }
    const context = this.save.actions.contextVersion;
    const promise = this.execute(identity, build, independent, {
      ...options,
      validIntent: () =>
        this.save.actions.contextVersion === context &&
        (!options?.validIntent || options.validIntent()),
    }).finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    this.flight = { identity, promise };
    return promise;
  }
  private async execute(
    identity: string,
    build: (revision: number) => ManuscriptCommand,
    independent: boolean,
    options?: {
      validIntent?: () => boolean;
      requestedVisible?: string;
      dispatched?: () => void;
    },
  ) {
    const prior = this.pending;
    if (
      prior?.command.type === "SetUserLocks" &&
      this.save.businessReceipt?.requestId === prior.command.requestId &&
      (await this.save.reconcileMetadataReceipt(prior.command))
    ) {
      this.pending = null;
      return {
        ok: prior.identity === identity,
        completed: prior.command,
        error: "",
        details: undefined,
      };
    }
    if (
      prior &&
      this.save.businessReceipt?.requestId === prior.command.requestId &&
      this.save.status === "saved" &&
      this.save.localBodyMatchesCanonical
    ) {
      this.pending = null;
      return {
        ok: prior.identity === identity,
        completed: prior.command,
        error: "",
        details: undefined,
      };
    }
    let attempted: ManuscriptCommand | null = prior?.command ?? null;
    const visible =
      prior?.visible ??
      options?.requestedVisible ??
      JSON.stringify(this.save.local);
    if (!attempted && independent)
      attempted = build(this.save.state.workingRevision);
    const cancellation =
      attempted?.type === "CancelReviewTask" ||
      attempted?.type === "CancelPlanningTask" ||
      (attempted?.type === "SetUserLocks" && !attempted.payload.locked);
    if (cancellation) {
      this.pending = { command: attempted!, identity, visible };
    }
    const ok = cancellation
      ? await this.save.cancelOrUnlock(attempted!)
      : await this.save.businessCore(
          (revision) => {
            attempted = prior?.command ?? build(revision);
            return attempted;
          },
          {
            ...options,
            requestedVisible: visible,
            replayCommand: () => prior?.command ?? null,
            dispatched: () => {
              if (attempted)
                this.pending = { command: attempted!, identity, visible };
              options?.dispatched?.();
            },
          },
        );
    const owned =
      attempted &&
      this.save.businessRejection?.requestId === attempted.requestId;
    const error = this.save.error;
    const details = this.save.businessErrorDetails;
    if (ok || owned) this.pending = null;
    if (!ok && owned) this.save.acknowledgeBusinessRejection();
    return {
      ok: ok && (!prior || prior.identity === identity),
      completed:
        ok ||
        (attempted &&
          this.save.businessReceipt?.requestId === attempted.requestId)
          ? attempted
          : null,
      error,
      details,
    };
  }
}
