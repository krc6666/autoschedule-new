import type { Flight, PositionRule, ScheduleSettings } from "../../model";
import {
  ACTIVE_SCHEDULING_RULES,
  SCHEDULING_RULES,
  schedulingRuleDefinition,
  type RuleFeedbackKey,
  type SchedulingRuleId,
  type SchedulingRuleOptimization,
} from "./schedule-rule-contract";
import {
  BUILT_IN_RULE_REGISTRY,
  builtInRulePreferences,
} from "./built-in-rule-registry";
import type {
  CandidatePriorityExecutor,
  PlannedSchedulingHook,
  ScheduleMutationExecutor,
} from "./rule-registry";
import type { LexicographicObjective } from "../solver/solver-port";

export interface CompiledCandidateRule {
  readonly id: SchedulingRuleId;
  readonly label: string;
  readonly stage: PlannedSchedulingHook["stage"];
  readonly source: PlannedSchedulingHook["source"];
  readonly execute: CandidatePriorityExecutor["execute"];
  readonly optimization: SchedulingRuleOptimization;
  readonly deferAfterCoverage: boolean;
}

export interface PlannedScheduleMutation {
  readonly ruleId: SchedulingRuleId;
  readonly label: string;
  readonly stage: string;
  readonly executor: ScheduleMutationExecutor;
}

export interface DailyObjectiveBuckets {
  readonly ke166Capacity?: readonly LexicographicObjective[];
  readonly ke166Reservation: readonly LexicographicObjective[];
  readonly ke166Availability?: readonly LexicographicObjective[];
  readonly duty: readonly LexicographicObjective[];
  readonly coverage: readonly LexicographicObjective[];
  readonly crossWorkdayReservation: readonly LexicographicObjective[];
  readonly strictTransition: readonly LexicographicObjective[];
  readonly crossFlightPriority: readonly LexicographicObjective[];
  readonly protectedFairness: readonly LexicographicObjective[];
  readonly dutyRelief: readonly LexicographicObjective[];
  readonly recovery: readonly LexicographicObjective[];
  readonly halfRest: readonly LexicographicObjective[];
  readonly remainingCandidate: readonly LexicographicObjective[];
}

export interface CompiledSchedulingPlan {
  readonly hooks: readonly PlannedSchedulingHook[];
  readonly candidateRules: readonly CompiledCandidateRule[];
  readonly coverageMutations: readonly PlannedScheduleMutation[];
  readonly postScheduleMutations: readonly PlannedScheduleMutation[];
  readonly feedbackKeys: readonly RuleFeedbackKey[];
}

const PASS_ORDER: readonly ScheduleMutationExecutor["pass"][] = [
  "primary",
  "mobile-supervisor-finalize",
  "after-mobile-supervisor",
];

function assertRegistryOrder(hooks: readonly PlannedSchedulingHook[]): void {
  const expected = ACTIVE_SCHEDULING_RULES.map((rule) => rule.id);
  const actual = hooks.map((hook) => hook.id);
  if (expected.length !== actual.length) {
    throw new Error("内置规则计划与中央规则合同数量不一致");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      throw new Error(
        `内置规则计划顺序漂移：中央 ${expected[index]}，实际 ${actual[index]}`
      );
    }
  }
}

function mutationPlan(
  hooks: readonly PlannedSchedulingHook[],
  kind: ScheduleMutationExecutor["kind"]
): PlannedScheduleMutation[] {
  return PASS_ORDER.flatMap((pass) =>
    hooks.flatMap((hook) => {
      if (!hook.enabled) return [];
      return hook.execute.flatMap<PlannedScheduleMutation>((executor) =>
        executor.kind === kind && executor.pass === pass
          ? [
              {
                ruleId: hook.id as SchedulingRuleId,
                label: hook.label,
                stage: executor.id,
                executor,
              },
            ]
          : []
      );
    })
  );
}

function feedbackKeys(): RuleFeedbackKey[] {
  const dedicated = SCHEDULING_RULES.filter(
    (
      rule
    ): rule is Extract<
      (typeof SCHEDULING_RULES)[number],
      { feedbackMode: "dedicated" }
    > => rule.feedbackMode === "dedicated"
  );
  const orders = dedicated.map((rule) => rule.feedbackOrder);
  if (
    orders.some((order) => !Number.isInteger(order)) ||
    new Set(orders).size !== orders.length
  )
    throw new Error("规则反馈展示顺序缺失或重复");
  return dedicated
    .sort((left, right) => left.feedbackOrder - right.feedbackOrder)
    .map((rule) => rule.feedbackKey);
}

function ruleOptimization(
  ruleId: SchedulingRuleId
): SchedulingRuleOptimization {
  const definition = schedulingRuleDefinition(ruleId);
  return "optimization" in definition ? definition.optimization : "required";
}

function ruleDefersAfterCoverage(ruleId: SchedulingRuleId): boolean {
  const definition = schedulingRuleDefinition(ruleId);
  return "deferCandidateAfterCoverage" in definition
    ? definition.deferCandidateAfterCoverage
    : false;
}

export function compileSchedulingPlan(
  settings: ScheduleSettings
): CompiledSchedulingPlan {
  const hooks = BUILT_IN_RULE_REGISTRY.executionPlan(
    builtInRulePreferences(settings)
  );
  assertRegistryOrder(hooks);
  const candidateRules = hooks.flatMap<CompiledCandidateRule>((hook) => {
    if (!hook.enabled) return [];
    return hook.execute.flatMap((executor) =>
      executor.kind === "candidate-priority"
        ? [
            {
              id: hook.id as SchedulingRuleId,
              label: hook.label,
              stage: hook.stage,
              source: hook.source,
              execute: executor.execute,
              optimization: ruleOptimization(hook.id as SchedulingRuleId),
              deferAfterCoverage: ruleDefersAfterCoverage(
                hook.id as SchedulingRuleId
              ),
            },
          ]
        : []
    );
  });
  return {
    hooks,
    candidateRules,
    coverageMutations: mutationPlan(hooks, "coverage"),
    postScheduleMutations: mutationPlan(hooks, "post-schedule"),
    feedbackKeys: feedbackKeys(),
  };
}

export function dailyObjectiveRuleId(
  objectiveId: string
): SchedulingRuleId | null {
  const candidates = [...SCHEDULING_RULES].sort(
    (left, right) => right.id.length - left.id.length
  );
  for (const rule of candidates) {
    if (
      objectiveId === `candidate:${rule.id}` ||
      objectiveId.startsWith(`candidate:${rule.id}:`) ||
      objectiveId === rule.id ||
      objectiveId.startsWith(`${rule.id}:`)
    )
      return rule.id;
  }
  return null;
}

export function dailyObjectiveIsBestEffort(objectiveId: string): boolean {
  const ruleId = dailyObjectiveRuleId(objectiveId);
  if (!ruleId) return false;
  return ruleOptimization(ruleId) === "best-effort";
}

export function orderDailyObjectiveBuckets(
  buckets: DailyObjectiveBuckets
): LexicographicObjective[] {
  const coverageBeforeKe166 = (buckets.ke166Availability?.length ?? 0) > 0;
  return [
    ...(buckets.ke166Capacity ?? []),
    ...(coverageBeforeKe166 ? buckets.coverage.slice(0, 2) : []),
    ...buckets.ke166Reservation,
    ...(buckets.ke166Availability ?? []),
    ...buckets.duty.filter(
      (objective) => objective.id !== "duty:preferred-morning"
    ),
    ...(coverageBeforeKe166 ? buckets.coverage.slice(2) : buckets.coverage),
    // A preferred morning counter must not manufacture a vacancy when the
    // duty worker can keep morning work on another safe counter.
    ...buckets.duty.filter(
      (objective) => objective.id === "duty:preferred-morning"
    ),
    ...buckets.crossWorkdayReservation,
    ...buckets.strictTransition,
    ...buckets.crossFlightPriority,
    ...buckets.protectedFairness,
    ...buckets.dutyRelief,
    ...buckets.recovery,
    ...buckets.halfRest,
    ...buckets.remainingCandidate,
  ];
}

export function candidateRuleAfterCoverage(
  rule: Pick<CompiledCandidateRule, "deferAfterCoverage">
): boolean {
  return rule.deferAfterCoverage;
}

export function postScheduleMutationApplies(
  item: PlannedScheduleMutation,
  flights: readonly Pick<Flight, "flightNo">[],
  positionRules: readonly Pick<PositionRule, "flightNo" | "category">[]
): boolean {
  if (item.executor.pass !== "after-mobile-supervisor") return true;
  const scheduledFlightNumbers = new Set(
    flights.map((flight) => flight.flightNo.trim().toUpperCase())
  );
  return positionRules.some(
    (rule) =>
      rule.category === "机动督导" &&
      scheduledFlightNumbers.has(rule.flightNo.trim().toUpperCase())
  );
}
