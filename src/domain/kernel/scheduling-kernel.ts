import type { ScheduleResult } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { finalizeMobileSupervisors } from "../assignments/ke166-supervisor-finalizer";
import { evaluateAutomaticHardConstraints } from "../rules/built-in-rule-registry";
import type { SolverPort } from "../solver/solver-port";
import type { DailySchedulePlan } from "./daily-schedule-result";
import { optimizeDailySchedule } from "./daily-schedule-optimizer";
import { finalizeSchedule } from "./schedule-finalizer";
import { createScheduleLedger } from "./schedule-ledger";
import { createScheduleSafetySession } from "./schedule-safety-session";
import { placePassivePosition } from "./schedule-passive-position";
import {
  prepareSchedule,
  type SchedulePreparation,
} from "./schedule-preparation";
import {
  scheduleProgressPercent,
  type ScheduleProgressStage,
} from "./schedule-progress";
import type { ScheduleRunPreferences } from "../shared/schedule-run-preferences";
import { createId } from "../../utils";
import { recoverLocalScheduleIssues } from "./schedule-local-recovery";

export type { ScheduleProgressStage } from "./schedule-progress";

export interface GenerateScheduleOptions {
  solver: SolverPort;
  checkpointSolver?: SolverPort;
  onProgress?: (stage: ScheduleProgressStage, percent: number) => void;
  onSafeResult?: (result: ScheduleResult) => void;
  preferences?: ScheduleRunPreferences;
}

interface FinalizePlanOptions {
  state: ScheduleGenerationFacts;
  date: string;
  solver: SolverPort;
  preparation: SchedulePreparation;
  plan: DailySchedulePlan;
  reportProgress: (stage: ScheduleProgressStage, percent: number) => void;
  scheduleRunId: string;
}

async function finalizeDailyPlan({
  state,
  date,
  solver,
  preparation,
  plan,
  reportProgress,
  scheduleRunId,
}: FinalizePlanOptions): Promise<ScheduleResult> {
  const warnings = [...plan.warnings];
  const guardWarnings: string[] = [];
  const partialSafetySession = createScheduleSafetySession({
    phase: "partial",
    state,
    date,
    runFacts: preparation.runFacts,
    warningSink: guardWarnings,
  });
  warnings.push(
    ...recoverLocalScheduleIssues(state, plan.assignments, (assignments) =>
      partialSafetySession.assertAssignmentsSafe(assignments)
    )
  );
  const ledger = createScheduleLedger(plan.assignments, {
    safetySession: partialSafetySession,
  });
  const automaticTaskKeys = new Set(preparation.tasks.map((task) => task.key));
  for (const flight of preparation.flights) {
    const displayRules = preparation.displayRulesByFlight.get(flight.id) ?? [];
    const displayIndex = new Map(
      displayRules.map((rule, index) => [rule.id, index])
    );
    for (const rule of displayRules) {
      if (automaticTaskKeys.has(`${flight.id}:${rule.id}`)) continue;
      placePassivePosition({
        state,
        ledger,
        warnings,
        flight,
        rule,
        displayIndex,
      });
    }
  }

  let mobileSupervisorsFinalized = false;
  return finalizeSchedule({
    solver,
    state,
    date,
    ledger,
    safetySession: createScheduleSafetySession({
      phase: "final",
      state,
      date,
      runFacts: preparation.runFacts,
      warningSink: guardWarnings,
    }),
    warnings,
    flights: preparation.flights,
    displayRulesByFlight: preparation.displayRulesByFlight,
    lockedAssignmentIds: plan.lockedAssignmentIds,
    dailyFlightCountBalanceFallback: plan.dailyFlightCountBalanceFallback,
    candidateStaffIds: new Set(
      [...preparation.eligibleStaffIds.values()].flatMap((ids) => [...ids])
    ),
    runFacts: preparation.runFacts,
    automaticTasks: preparation.tasks,
    preservedAssignments: plan.assignments
      .filter((assignment) => plan.lockedAssignmentIds.has(assignment.id))
      .map((assignment) => structuredClone(assignment)),
    optimizationQuality: plan.optimizationQuality,
    finalizeMobileSupervisors: async () => {
      if (mobileSupervisorsFinalized) return;
      const assignments = ledger
        .snapshot()
        .map((assignment) => structuredClone(assignment));
      await finalizeMobileSupervisors({
        solver,
        state,
        date,
        assignments,
        preparation,
        lockedAssignmentIds: plan.lockedAssignmentIds,
      });
      ledger.commit({ type: "replace", assignments });
      mobileSupervisorsFinalized = true;
    },
    reportProgress,
    scheduleRunId,
  });
}

export async function generateSchedule(
  state: ScheduleGenerationFacts,
  date: string,
  options: GenerateScheduleOptions
): Promise<ScheduleResult> {
  const reportProgress = (
    stage: ScheduleProgressStage,
    percent: number
  ): void => options.onProgress?.(stage, percent);
  reportProgress("prepare", scheduleProgressPercent("prepare"));
  const preparation = prepareSchedule(
    state,
    date,
    evaluateAutomaticHardConstraints,
    options.preferences
  );
  reportProgress("optimize", scheduleProgressPercent("optimize"));

  let pendingCheckpoint: DailySchedulePlan | null = null;
  const scheduleRunId = createId("schedule-run");
  let checkpointRunning = false;
  const queueCheckpoint = (checkpointPlan: DailySchedulePlan): void => {
    if (!options.onSafeResult || !options.checkpointSolver) return;
    pendingCheckpoint = checkpointPlan;
    if (checkpointRunning) return;
    checkpointRunning = true;
    const processLatest = async (): Promise<void> => {
      while (pendingCheckpoint) {
        const current = pendingCheckpoint;
        pendingCheckpoint = null;
        try {
          const safeResult = await finalizeDailyPlan({
            state,
            date,
            solver: options.checkpointSolver!,
            preparation,
            plan: current,
            reportProgress: () => undefined,
            scheduleRunId,
          });
          options.onSafeResult?.(safeResult);
        } catch {
          // A checkpoint is only published after the full safety review.
        }
      }
      checkpointRunning = false;
    };
    void processLatest();
  };

  const plan = await optimizeDailySchedule({
    solver: options.solver,
    state,
    date,
    preparation,
    onRequiredPlan: queueCheckpoint,
    onImprovedPlan: queueCheckpoint,
  });

  reportProgress("assign", scheduleProgressPercent("assign"));
  const result = await finalizeDailyPlan({
    state,
    date,
    solver: options.solver,
    preparation,
    plan,
    reportProgress,
    scheduleRunId,
  });
  reportProgress("complete", scheduleProgressPercent("complete"));
  return result;
}
