import { useEffect, useRef, useState, useMemo } from "react";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type {
  PlanningPreparationRequest,
  PlanningState,
  ManuscriptCommand,
} from "@scenesparrow/contracts";
import type { Autosave } from "./autosave";
import { ReviewCommands } from "./review-commands";
import { PlanningAutosave } from "./planning-autosave";
import { useNoticeOwner } from "../NotificationPresenter";

export type WritingView = "outline" | "manuscript";
export function usePlanningSession(
  client: PlatformClient,
  save: Autosave,
  projectId: string,
  onApplied: (view: WritingView) => void,
) {
  const [, render] = useState(0),
    [planning, setPlanning] = useState<PlanningAutosave | null>(null),
    [attempt, retry] = useState(0),
    [acting, setActing] = useState(false),
    [recovery, setRecovery] = useState(false),
    [diagnostics, setDiagnostics] = useState(false);
  const { report, resolve } = useNoticeOwner();
  const commands = useMemo(() => new ReviewCommands(save), [save]);
  const pendingStart = useRef<{
    command: ManuscriptCommand;
    operation: PlanningPreparationRequest["operation"];
    accepted: boolean;
    dispatched: boolean;
  } | null>(null);
  const applied = useRef(onApplied);
  applied.current = onApplied;
  const live = useRef(true),
    flight = useRef(false),
    observed = useRef(new Set<string>()),
    started = useRef(new Set<string>());
  useEffect(() => {
    live.current = true;
    let owned: PlanningAutosave | null = null,
      active = true;
    void client.readPlanning().then(
      (initial) => {
        if (!active) return;
        observed.current = new Set(
          initial.tasks
            .filter((task) => task.application === "applied")
            .map((task) => task.id),
        );
        owned = new PlanningAutosave(initial, save, client, projectId, () =>
          render((n) => n + 1),
        );
        setPlanning(owned);
        resolve("planning-load");
      },
      (error) => {
        if (active)
          report(error, {
            identity: "planning-load",
            actions: [{ kind: "retry", run: () => retry((n) => n + 1) }],
          });
      },
    );
    return () => {
      active = false;
      live.current = false;
      owned?.dispose();
    };
  }, [client, save, projectId, attempt, report, resolve]);
  useEffect(() => {
    if (!planning) return;
    let active = true,
      refreshing = false,
      again = false;
    const inspect = (state: PlanningState) => {
      for (const task of state.tasks) {
        if (task.application !== "applied" || observed.current.has(task.id))
          continue;
        observed.current.add(task.id);
        if (started.current.has(task.id))
          applied.current(
            task.operation === "generate_initial_draft"
              ? "manuscript"
              : "outline",
          );
      }
    };
    const refresh = async () => {
      again = true;
      if (refreshing || !active) return;
      refreshing = true;
      try {
        while (again && active) {
          again = false;
          await planning.refresh();
          await save.resync();
          if (active) {
            inspect(planning.state);
            resolve("planning-refresh");
          }
        }
      } catch (error) {
        if (active)
          report(error, { identity: "planning-refresh", passive: true });
      } finally {
        refreshing = false;
      }
    };
    const stop = client.subscribeEvents(
      (event) => {
        if (
          [
            "planning.changed",
            "planningTask.changed",
            "draft.created",
            "history.changed",
            "aiRun.changed",
          ].includes(event.type)
        )
          void refresh();
      },
      () => void refresh(),
    );
    const timer = setInterval(() => {
      if (
        planning.state.tasks.some(
          (task) =>
            task.application === "pending" &&
            ["queued", "running", "cancelling", "succeeded"].includes(
              task.run.status,
            ),
        )
      )
        void refresh();
    }, 1000);
    return () => {
      active = false;
      stop();
      clearInterval(timer);
    };
  }, [client, planning, save, report, resolve]);
  async function start(
    operation: PlanningPreparationRequest["operation"],
    retryOfTaskId: string | null = null,
  ) {
    if (!planning || flight.current) return false;
    flight.current = true;
    setActing(true);
    const intent = planning.identity();
    let attempted = pendingStart.current;
    const recovering = !!attempted;
    try {
      if (!attempted) {
        if (!(await planning.flush()) || intent !== planning.identity())
          return false;
        const preparation = await client.preparePlanning({ operation });
        if (
          !live.current ||
          intent !== planning.identity() ||
          planning.composing
        )
          return false;
        const requestId = crypto.randomUUID();
        attempted = {
          command: {
            type: "StartPlanningTask",
            requestId,
            projectId,
            expectedWorkingRevision: save.state.workingRevision,
            payload: { preparationId: preparation.id, retryOfTaskId },
          },
          operation,
          accepted: false,
          dispatched: false,
        };
        pendingStart.current = attempted;
        // Script task/run identity is the immutable start command identity.
        started.current.add(requestId);
      }
      const owned = attempted;
      if (!owned.accepted) {
        const result = await commands.run(
          `planning-start:${owned.command.requestId}`,
          (revision) => {
            if (!owned.dispatched) {
              owned.command = {
                ...owned.command,
                expectedWorkingRevision: revision,
              };
              owned.dispatched = true;
            }
            return owned.command;
          },
          {
            validIntent: () =>
              !!pendingStart.current &&
              pendingStart.current === owned &&
              !planning.composing &&
              (recovering || planning.identity() === intent),
          },
        );
        if (!result.ok) {
          if (!save.hasUnresolvedBusiness && !result.completed)
            pendingStart.current = null;
          report(result.error || "SAVE_FAILED", {
            identity: "planning-start",
            actions: [
              {
                kind: "retry",
                run: () => start(owned.operation, retryOfTaskId),
              },
              { kind: "recovery", run: () => setRecovery(true) },
            ],
          });
          return false;
        }
        owned.accepted = true;
      }
      await planning.refresh();
      await save.resync();
      if (!live.current) return false;
      const task = planning.state.tasks.find(
        (task) => task.id === owned.command.requestId,
      );
      if (task?.application === "applied" && !observed.current.has(task.id)) {
        observed.current.add(task.id);
        applied.current(
          owned.operation === "generate_initial_draft"
            ? "manuscript"
            : "outline",
        );
      }
      pendingStart.current = null;
      resolve("planning-start");
      resolve("planning-refresh");
      return true;
    } catch (error) {
      report(error, {
        identity: "planning-start",
        actions: [
          {
            kind: "retry",
            run: () => start(attempted?.operation ?? operation, retryOfTaskId),
          },
        ],
      });
      return false;
    } finally {
      flight.current = false;
      if (live.current) setActing(false);
    }
  }
  async function control(
    type: "CancelPlanningTask" | "UsePlanningResult",
    taskId: string,
  ) {
    if (!planning || flight.current) return;
    flight.current = true;
    setActing(true);
    try {
      const build = (revision: number) =>
        ({
          type,
          requestId: crypto.randomUUID(),
          projectId,
          expectedWorkingRevision: revision,
          payload:
            type === "CancelPlanningTask"
              ? { taskId }
              : {
                  taskId,
                  expectedHistoryRevision: save.history.historyRevision,
                  explicit: true,
                },
        }) as ManuscriptCommand;
      const ok =
        type === "CancelPlanningTask"
          ? (await commands.run(`CancelPlanningTask:${taskId}`, build)).ok
          : await planning.control(build);
      if (ok) {
        await planning.refresh();
        await save.resync();
      }
      if (!ok) report(planning.error || save.error || "SAVE_FAILED");
      else if (type === "UsePlanningResult") {
        observed.current.add(taskId);
        const task = planning.state.tasks.find((task) => task.id === taskId);
        if (task?.application === "applied")
          applied.current(
            task.operation === "generate_initial_draft"
              ? "manuscript"
              : "outline",
          );
      }
    } catch (error) {
      report(error);
    } finally {
      flight.current = false;
      if (live.current) setActing(false);
    }
  }
  const previous = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!planning) return;
    const old = previous.current;
    previous.current = new Map(
      planning.state.tasks.map((task) => [
        task.id,
        `${task.run.status}:${task.error ?? task.run.error}`,
      ]),
    );
    if (!old) return;
    for (const task of planning.state.tasks) {
      const error = task.error ?? task.run.error;
      if (
        error &&
        !["CANCELLED", "NO_CHANGE"].includes(error) &&
        (task.error ||
          ["failed", "interrupted", "stale"].includes(task.run.status)) &&
        old.get(task.id) !== previous.current.get(task.id)
      )
        report(error, {
          identity: `planning-task:${task.id}`,
          actions: [
            {
              kind: "retry",
              run: () =>
                start(
                  task.operation as PlanningPreparationRequest["operation"],
                  task.id,
                ),
            },
            { kind: "recovery", run: () => setDiagnostics(true) },
          ],
        });
    }
  }, [planning?.state.tasks, report]);
  return {
    planning,
    acting,
    start,
    control,
    recovery,
    setRecovery,
    diagnostics,
    setDiagnostics,
  };
}
export type PlanningSession = ReturnType<typeof usePlanningSession>;
