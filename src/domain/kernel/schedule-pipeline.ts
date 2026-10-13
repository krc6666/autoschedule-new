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
import {
  ScheduleGuardError,
  type ScheduleGuardViolation,
} from "./schedule-guard";
import { guardExplanation } from "../shared/schedule-issue-explanation";

export interface SchedulePipelineContext extends ScheduleMutationContext {
  onProgress?: (stage: ScheduleProgressStage, percent: number) => void;
  onMutationRejected?: (
    item: PlannedScheduleMutation,
    violations: readonly ScheduleGuardViolation[]
  ) => void;
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
    const before = context.ledger.snapshot().map((row) => structuredClone(row));
    const locksBefore = new Set(context.lockedAssignmentIds);
    try {
      const proposal = await item.executor.execute(context);
      if (proposal.assignments) {
        context.ledger.commit({
          type: "replace",
          assignments: proposal.assignments,
        });
      }
      warnings.push(...proposal.warnings);
    } catch (error) {
      if (!(error instanceof ScheduleGuardError)) throw error;
      context.ledger.commit({ type: "replace", assignments: before });
      context.lockedAssignmentIds.clear();
      locksBefore.forEach((id) => context.lockedAssignmentIds.add(id));
      context.onMutationRejected?.(item, error.violations);
      warnings.push(
        `${item.label}未采用：${error.violations.map(guardExplanation).join("；")}已保留调整前的安排，继续排其他岗位。`
      );
    }
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
