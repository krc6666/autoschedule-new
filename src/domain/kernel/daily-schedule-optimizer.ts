import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import type { SolverPort } from "../solver/solver-port";
import { dailyScheduleFailureMessage } from "../solver/solver-user-message";
import { diagnoseDailyScheduleFailure } from "./daily-schedule-diagnostics";
import { buildDailyScheduleModel } from "./daily-schedule-model";
import {
  materializeValidatedDailySchedulePlan,
  validatedPlanCallback,
  type DailySchedulePlan,
} from "./daily-schedule-result";
import { assertTimeLimitedResultIsEligible } from "./daily-schedule-safety";
import type { SchedulePreparation } from "./schedule-preparation";
import { dailyScheduleTimeoutMs } from "./daily-schedule-time-budget";
export interface OptimizeDailyScheduleOptions {
  solver: SolverPort;
  state: ScheduleGenerationFacts;
  date: string;
  preparation: SchedulePreparation;
  onRequiredPlan?: (plan: DailySchedulePlan) => void;
  onImprovedPlan?: (plan: DailySchedulePlan) => void;
}
export async function optimizeDailySchedule({
  solver,
  state,
  date,
  preparation,
  onRequiredPlan,
  onImprovedPlan,
}: OptimizeDailyScheduleOptions): Promise<DailySchedulePlan> {
  const timeoutMs = dailyScheduleTimeoutMs(state, date);
  const deadline = Date.now() + timeoutMs;
  const model = buildDailyScheduleModel({
    state,
    date,
    preparation,
    timeoutMs,
  });
  if (!model)
    return {
      assignments: [],
      lockedAssignmentIds: new Set(),
      dailyFlightCountBalanceFallback: false,
      warnings: [],
      optimizationQuality: "all-objectives-optimal",
    };
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0)
    throw new Error("当天整体排班计算超过允许时间（最长5分钟），请重试");
  const materializePlan = (
    selectedVariableIds: ReadonlySet<string>,
    optimizationQuality: DailySchedulePlan["optimizationQuality"]
  ) =>
    materializeValidatedDailySchedulePlan({
      state,
      date,
      preparation,
      model,
      selectedVariableIds,
      optimizationQuality,
    });
  const result = await solver.solve(
    {
      ...model.problem,
      timeoutMs: remainingMs,
    },
    onRequiredPlan || onImprovedPlan
      ? {
          onRequiredSolution: validatedPlanCallback(
            { state, date, preparation, model },
            onRequiredPlan,
            () => "fairness-user-stopped"
          ),
          onBestEffortSolution: validatedPlanCallback(
            { state, date, preparation, model },
            onImprovedPlan,
            () => "fairness-user-stopped"
          ),
        }
      : undefined
  );
  if (
    result.termination !== "optimal" &&
    result.termination !== "gap-limited-feasible" &&
    result.termination !== "time-limited-feasible"
  )
    throw new Error(
      dailyScheduleFailureMessage(
        result.termination,
        result.termination === "infeasible"
          ? diagnoseDailyScheduleFailure({ state, preparation, model })
          : []
      )
    );
  assertTimeLimitedResultIsEligible(model.problem, result);
  return materializePlan(
    result.selectedVariableIds,
    result.termination === "gap-limited-feasible"
      ? "fairness-gap-limited"
      : result.termination === "time-limited-feasible"
        ? "fairness-time-limited"
        : "all-objectives-optimal"
  );
}
