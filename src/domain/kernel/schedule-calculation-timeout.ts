import { dailyScheduleFailureMessage } from "../solver/solver-user-message";
import type { SolverProblem, SolverResult } from "../solver/solver-port";
import { assertTimeLimitedResultIsEligible } from "./daily-schedule-safety";

export class ScheduleCalculationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleCalculationTimeoutError";
  }
}

export function assertDailyScheduleSolveResult(
  problem: SolverProblem,
  result: SolverResult,
  failureMessage: string
): void {
  if (result.termination === "timed-out")
    throw new ScheduleCalculationTimeoutError(
      dailyScheduleFailureMessage(result.termination)
    );
  if (
    result.termination !== "optimal" &&
    result.termination !== "gap-limited-feasible" &&
    result.termination !== "time-limited-feasible"
  )
    throw new Error(failureMessage);
  try {
    assertTimeLimitedResultIsEligible(problem, result);
  } catch (error) {
    if (result.termination !== "time-limited-feasible") throw error;
    throw new ScheduleCalculationTimeoutError(
      error instanceof Error ? error.message : "核心排班目标超时未完成"
    );
  }
}
