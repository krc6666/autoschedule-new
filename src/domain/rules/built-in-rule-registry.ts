import type { ScheduleSettings } from "../../model";
import {
  ACTIVE_SCHEDULING_RULES,
  type SchedulingRuleId,
} from "./schedule-rule-contract";
import {
  diagnoseSameAirlinePriorityEligibility,
  diagnoseAutomaticStaffEligibility,
  diagnoseMinimumFlightTransitionEligibility,
  diagnoseSameFlightStaffExclusionEligibility,
  diagnoseDailyPrimaryPositionEligibility,
} from "../candidates/assignment-eligibility";
import type {
  AssignmentEligibilityDiagnostic,
  AutomaticAssignmentEligibilityOptions,
} from "../candidates/assignment-eligibility";
import {
  compareDutyPosition,
  compareKe166Reservation,
  compareLatePriorityAggregateRotation,
  compareLatePriorityFrequency,
  compareLateShiftCutoff,
  compareLateShiftRecovery,
  compareNumber,
  comparePositionFrequency,
  comparePreferredPositionTransition,
  comparePreviousWorkdayLoadPriority,
  compareScarceQualification,
  compareStrictPositionTransition,
  compareTr121H02Cooldown,
  compareWorkloadBalance,
  type CandidatePriority,
} from "../candidates/candidate-priority";
import { reviewLateShiftCutoff } from "../reviews/late-shift-cutoff-review";
import { reviewLateShiftRecovery } from "../reviews/late-shift-recovery-review";
import { reviewLatePriorityFrequency } from "../reviews/late-priority-frequency-review";
import { reviewSamePositionFrequency } from "../reviews/position-frequency-review";
import { reviewConsecutivePositionRotation } from "../reviews/position-rotation-review";
import {
  createRuleRegistry,
  type CandidatePriorityExecutor,
  type RulePreference,
  type ScheduleMutationContext,
  type ScheduleMutationExecutor,
  type ScheduleMutationProposal,
  type SchedulingHook,
  type SchedulingHookExecutor,
} from "./rule-registry";
import { compactRegularAssignments } from "../coverage/schedule-coverage";

export const CONFIGURABLE_RULE_SETTINGS: Partial<
  Record<
    SchedulingRuleId,
    keyof Pick<
      ScheduleSettings,
      | "highLoadProtectionEnabled"
      | "rollingLoadProtectionEnabled"
      | "positionRotationEnabled"
      | "sameDayCrossFlightPriorityEnabled"
      | "dailyPrimaryPositionUniqueEnabled"
      | "lateShiftRecoveryEnabled"
      | "workloadBalanceEnabled"
    >
  >
> = {
  "late-shift-recovery": "lateShiftRecoveryEnabled",
  "late-shift-cutoff": "lateShiftRecoveryEnabled",
  "priority-position-consecutive": "positionRotationEnabled",
  "high-fatigue-position-consecutive": "positionRotationEnabled",
  "rolling-load": "rollingLoadProtectionEnabled",
  "high-load-recovery": "highLoadProtectionEnabled",
  "position-frequency": "positionRotationEnabled",
  "late-priority-aggregate-rotation": "positionRotationEnabled",
  "late-priority-frequency": "positionRotationEnabled",
  "position-frequency-review": "positionRotationEnabled",
  "workload-balance": "workloadBalanceEnabled",
  "position-rotation": "positionRotationEnabled",
  "same-day-cross-flight-priority": "sameDayCrossFlightPriorityEnabled",
  "daily-primary-position-unique": "dailyPrimaryPositionUniqueEnabled",
};

type CandidateComparator = (
  left: CandidatePriority,
  right: CandidatePriority
) => number;

function candidate(execute: CandidateComparator): CandidatePriorityExecutor {
  return {
    kind: "candidate-priority",
    execute: ({ leftPriority, rightPriority }) =>
      execute(leftPriority, rightPriority),
  };
}

function mutableAssignments(context: ScheduleMutationContext) {
  return context.ledger
    .snapshot()
    .map((assignment) => structuredClone(assignment));
}

function review(
  stage: string,
  pass: ScheduleMutationExecutor["pass"],
  execute: (
    context: ScheduleMutationContext
  ) => ScheduleMutationProposal | Promise<ScheduleMutationProposal>
): ScheduleMutationExecutor {
  return {
    kind: "post-schedule",
    id: stage,
    pass,
    execute,
  };
}

const lateShiftRecoveryReview = async (context: ScheduleMutationContext) => {
  const assignments = mutableAssignments(context);
  return {
    assignments,
    warnings: await reviewLateShiftRecovery(
      context.solver,
      context.state,
      assignments,
      context.date,
      context.lockedAssignmentIds,
      context.runFacts
    ),
  };
};

const lateShiftCutoffReview = async (context: ScheduleMutationContext) => {
  const assignments = mutableAssignments(context);
  return {
    assignments,
    warnings: await reviewLateShiftCutoff(
      context.solver,
      context.state,
      assignments,
      context.date,
      context.lockedAssignmentIds,
      context.runFacts
    ),
  };
};

const positionFrequencyReview = async (context: ScheduleMutationContext) => {
  const assignments = mutableAssignments(context);
  return {
    assignments,
    warnings: await reviewSamePositionFrequency(
      context.solver,
      context.state,
      assignments,
      context.date,
      context.lockedAssignmentIds,
      context.runFacts
    ),
  };
};

const latePriorityFrequencyReview = async (
  context: ScheduleMutationContext
) => {
  const assignments = mutableAssignments(context);
  return {
    assignments,
    warnings: await reviewLatePriorityFrequency(
      context.solver,
      context.state,
      assignments,
      context.date,
      context.lockedAssignmentIds,
      context.runFacts
    ),
  };
};

const positionRotationReview = async (context: ScheduleMutationContext) => {
  const assignments = mutableAssignments(context);
  return {
    assignments,
    warnings: await reviewConsecutivePositionRotation(
      context.solver,
      context.state,
      assignments,
      context.date,
      context.lockedAssignmentIds,
      context.runFacts
    ),
  };
};

const RULE_EXECUTION: Readonly<
  Record<
    SchedulingRuleId,
    readonly [SchedulingHookExecutor, ...SchedulingHookExecutor[]]
  >
> = {
  "staff-eligibility": [
    {
      kind: "hard-constraint",
      execute: diagnoseAutomaticStaffEligibility,
    },
  ],
  "same-flight-staff-exclusion": [
    {
      kind: "hard-constraint",
      execute: diagnoseSameFlightStaffExclusionEligibility,
    },
  ],
  "daily-primary-position-unique": [
    {
      kind: "hard-constraint",
      execute: diagnoseDailyPrimaryPositionEligibility,
    },
  ],
  "minimum-flight-transition": [
    {
      kind: "hard-constraint",
      execute: diagnoseMinimumFlightTransitionEligibility,
    },
  ],
  "strict-next-workday-recovery": [
    {
      kind: "daily-model",
      id: "strict-next-workday-recovery",
    },
  ],
  "mobile-supervisor": [
    {
      kind: "post-schedule",
      id: "mobile-supervisor-finalize",
      pass: "mobile-supervisor-finalize",
      execute: async (context) => {
        await context.finalizeMobileSupervisors();
        return { warnings: [] };
      },
    },
  ],
  "ke166-supervisor": [candidate(compareKe166Reservation)],
  "duty-position": [candidate(compareDutyPosition)],
  "scarce-qualification": [candidate(compareScarceQualification)],
  "position-compaction": [
    {
      kind: "coverage",
      id: "position-compaction",
      pass: "primary",
      execute: (context) => {
        const assignments = mutableAssignments(context);
        compactRegularAssignments(
          context.state,
          assignments,
          context.lockedAssignmentIds,
          context.date,
          context.runFacts.scheduleFrequency,
          context.runFacts.halfRest
        );
        return { assignments, warnings: [] };
      },
    },
  ],
  "team-leader-concurrent-supervision": [candidate(() => 0)],
  "cross-workday-qualification-reservation": [
    {
      kind: "daily-model",
      id: "cross-workday-qualification-reservation",
    },
  ],
  "cross-flight-priority": [
    { kind: "daily-model", id: "cross-flight-priority" },
  ],
  "position-transition": [candidate(compareStrictPositionTransition)],
  "tr121-h02-cooldown": [candidate(compareTr121H02Cooldown)],
  "late-priority-aggregate-rotation": [
    candidate(compareLatePriorityAggregateRotation),
  ],
  "late-shift-recovery": [
    candidate(compareLateShiftRecovery),
    review("late-shift-recovery", "primary", lateShiftRecoveryReview),
  ],
  "late-shift-cutoff": [
    candidate(compareLateShiftCutoff),
    review("late-shift-cutoff", "primary", lateShiftCutoffReview),
  ],
  "half-rest-morning": [
    {
      kind: "daily-model",
      id: "half-rest-morning",
    },
  ],
  "half-rest-early-finish": [
    {
      kind: "daily-model",
      id: "half-rest-early-finish",
    },
  ],
  "priority-position-consecutive": [
    candidate(
      (left, right) =>
        Number(left.repeatedPriorityPosition) -
        Number(right.repeatedPriorityPosition)
    ),
  ],
  "high-fatigue-position-consecutive": [
    candidate(
      (left, right) =>
        Number(left.repeatedHighFatiguePosition) -
        Number(right.repeatedHighFatiguePosition)
    ),
  ],
  "same-day-late-obligation": [
    {
      kind: "daily-model",
      id: "same-day-late-obligation",
    },
  ],
  "same-day-cross-flight-priority": [
    {
      kind: "hard-constraint",
      execute: diagnoseSameAirlinePriorityEligibility,
    },
  ],
  "late-shift-position-relief": [
    {
      kind: "daily-model",
      id: "late-shift-position-relief",
    },
  ],
  "preferred-position-transition": [
    candidate(comparePreferredPositionTransition),
  ],
  "staff-coverage": [
    {
      kind: "candidate-priority",
      execute: ({ left, leftPriority, right, rightPriority }) =>
        Number(left.teamLeader || leftPriority.alreadyAssignedToday) -
        Number(right.teamLeader || rightPriority.alreadyAssignedToday),
    },
  ],
  "daily-flight-count-balance": [candidate(() => 0)],
  "rolling-load": [
    candidate((left, right) =>
      compareNumber(left.rollingLoadExcess, right.rollingLoadExcess)
    ),
  ],
  "high-load-recovery": [
    candidate(
      (left, right) =>
        Number(left.highLoadRecoveryConflict) -
        Number(right.highLoadRecoveryConflict)
    ),
  ],
  "late-priority-frequency": [
    candidate(compareLatePriorityFrequency),
    review("late-priority-frequency", "primary", latePriorityFrequencyReview),
    review(
      "post-mobile-supervisor-late-priority-frequency-validation",
      "after-mobile-supervisor",
      latePriorityFrequencyReview
    ),
  ],
  "cross-workday-load": [candidate(comparePreviousWorkdayLoadPriority)],
  "position-frequency": [candidate(comparePositionFrequency)],
  "position-frequency-review": [
    review("position-frequency", "primary", positionFrequencyReview),
    review(
      "post-mobile-supervisor-frequency-validation",
      "after-mobile-supervisor",
      positionFrequencyReview
    ),
  ],
  "workload-balance": [candidate(compareWorkloadBalance)],
  "historical-fatigue": [
    candidate((left, right) =>
      compareNumber(left.historicalFatigue, right.historicalFatigue)
    ),
  ],
  "position-rotation": [
    review("position-rotation", "primary", positionRotationReview),
    review(
      "post-mobile-supervisor-rotation-validation",
      "after-mobile-supervisor",
      positionRotationReview
    ),
  ],
};

export const BUILT_IN_SCHEDULING_HOOKS: readonly SchedulingHook[] =
  ACTIVE_SCHEDULING_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    stage: rule.stage,
    defaultEnabled: true,
    configurable: CONFIGURABLE_RULE_SETTINGS[rule.id] !== undefined,
    before: [],
    after: [],
    source: "built-in",
    execute: RULE_EXECUTION[rule.id],
  }));

export const BUILT_IN_RULE_REGISTRY = createRuleRegistry(
  BUILT_IN_SCHEDULING_HOOKS
);

const AUTOMATIC_HARD_CONSTRAINT_EXECUTORS =
  BUILT_IN_RULE_REGISTRY.executionPlan().flatMap((hook) =>
    hook.enabled && hook.id !== "same-day-cross-flight-priority"
      ? hook.execute.filter((executor) => executor.kind === "hard-constraint")
      : []
  );

export function evaluateAutomaticHardConstraints(
  context: AutomaticAssignmentEligibilityOptions
): AssignmentEligibilityDiagnostic {
  const violations = AUTOMATIC_HARD_CONSTRAINT_EXECUTORS.flatMap(
    (executor) => executor.execute(context).violations
  );
  return { eligible: violations.length === 0, violations };
}

export function builtInRulePreferences(
  settings: ScheduleSettings
): RulePreference[] {
  return BUILT_IN_SCHEDULING_HOOKS.map((hook) => {
    const setting =
      CONFIGURABLE_RULE_SETTINGS[
        hook.id as keyof typeof CONFIGURABLE_RULE_SETTINGS
      ];
    return {
      id: hook.id,
      enabled: setting ? Boolean(settings[setting]) : true,
    };
  });
}
