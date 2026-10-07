import type { Flight, PositionRule, ScheduleSettings } from "../../model";
import type { ScheduleMutationContext } from "../rules/rule-registry";
import {
  compileSchedulingPlan,
  postScheduleMutationApplies,
  type PlannedScheduleMutation,
} from "../rules/scheduling-execution-plan";
import {
  scheduleProgressStep,
  type ScheduleProgressStage,
  type ScheduleProgressStep,
  visibleScheduleProgressStep,
} from "./schedule-progress";
import { ScheduleGuardError } from "./schedule-guard";

export interface SchedulePipelineContext extends ScheduleMutationContext {
  onProgress?: (stage: ScheduleProgressStage, percent: number) => void;
}

export function coverageHookPlan(
  settings: ScheduleSettings
): PlannedScheduleMutation[] {
  return [...compileSchedulingPlan(settings).coverageMutations];
}

export function postScheduleReviewPlan(
  settings: ScheduleSettings
): PlannedScheduleMutation[] {
  return [...compileSchedulingPlan(settings).postScheduleMutations];
}

export function plannedScheduleProgress(
  settings: ScheduleSettings,
  flights: readonly Pick<Flight, "flightNo">[],
  positionRules: readonly Pick<PositionRule, "flightNo" | "category">[]
): readonly ScheduleProgressStep[] {
  const mutationStages = [
    ...coverageHookPlan(settings),
    ...postScheduleReviewPlan(settings),
  ]
    .filter((item) => mutationApplies(item, flights, positionRules))
    .flatMap((item) =>
      visibleScheduleProgressStep(item.stage) ? [item.stage] : []
    );
  const stages: ScheduleProgressStage[] = [
    "prepare",
    "optimize",
    "assign",
    ...mutationStages,
    "complete",
  ];
  return [...new Set(stages)].map(scheduleProgressStep);
}

function mutationApplies(
  item: PlannedScheduleMutation,
  flights: readonly Pick<Flight, "flightNo">[],
  positionRules: readonly Pick<PositionRule, "flightNo" | "category">[]
): boolean {
  return postScheduleMutationApplies(item, flights, positionRules);
}

export async function runScheduleMutationPlan(
  context: SchedulePipelineContext,
  plan: readonly PlannedScheduleMutation[]
): Promise<string[]> {
  const warnings: string[] = [];
  for (const item of plan) {
    if (!mutationApplies(item, context.flights, context.state.positionRules))
      continue;
    const progress = visibleScheduleProgressStep(item.stage);
    if (progress) context.onProgress?.(progress.stage, progress.percent);
    const proposal = await item.executor.execute(context);
    if (proposal.assignments) {
      try {
        context.ledger.commit({
          type: "replace",
          assignments: proposal.assignments,
        });
      } catch (error) {
        if (
          !(error instanceof ScheduleGuardError) ||
          !error.violations.some(
            (violation) => violation.ruleId === "daily-primary-position-unique"
          )
        )
          throw error;
        warnings.push(`后置调整因最终硬约束未满足而回退：${error.message}`);
      }
    }
    warnings.push(...proposal.warnings);
  }
  return warnings;
}

export function runCoveragePipeline(
  context: SchedulePipelineContext
): Promise<string[]> {
  return runScheduleMutationPlan(
    context,
    coverageHookPlan(context.state.settings)
  );
}

export function runPostSchedulePipeline(
  context: SchedulePipelineContext
): Promise<string[]> {
  return runScheduleMutationPlan(
    context,
    postScheduleReviewPlan(context.state.settings)
  );
}
