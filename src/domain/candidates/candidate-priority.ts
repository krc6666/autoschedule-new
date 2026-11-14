import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  administrativeSupportAutomaticRule,
  isGuideAssignment,
} from "../flights/schedule-position-rules";
import {
  priorityPositionScarceQualification,
  scarceQualificationPriority,
  type ScarceQualificationPriority,
} from "./candidate-qualification";
import {
  dutyPositionPriority,
  type DutyPositionDisposition,
} from "../assignments/duty-assignment";
import { previousWorkdayLoadForStaff } from "../shared/previous-workday-load";
import {
  consecutivePositionAssignments,
  positionFrequencyProfileForRule,
} from "../statistics/schedule-frequency";
import {
  compareLatePriorityAggregate as compareLatePriorityAggregateProfile,
  compareLatePriorityCategoryBoundary as compareLatePriorityCategoryBoundaryProfile,
  compareLatePriorityFrequency as compareLatePriorityFrequencyProfile,
  compareLatePriorityFrequencyForKind as compareLatePriorityFrequencyProfileForKind,
  latePriorityFrequencyProfileForRule,
  type LatePriorityFrequencyProfile,
} from "../statistics/late-priority-frequency";
import type { LatePriorityFrequencyKind } from "../reviews/late-priority-policy";
import {
  hasHighLoadTransition,
  lateShiftCutoffPriority,
  lateShiftRecoveryPriority,
  positionTransitionInsertionCost,
  rollingLoadCost,
  totalFatiguePriority,
  type LateShiftCutoffPriority,
  type LateShiftRecoveryPriority,
} from "../reviews/schedule-protection";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import type { AssignmentTask } from "../flights/schedule-tasks";
import {
  isHighFatigueOrdinaryRotationPosition,
  isOrdinaryPriorityPosition,
} from "../reviews/position-rotation-policy";
import { intervalsOverlap } from "../shared/time";
import { isDutyAfternoonFlight } from "../assignments/duty-afternoon-relief";
import { isKe166MobileSupervisor } from "../flights/schedule-tasks";
import {
  workloadBalancePriority,
  type WorkloadBalanceLoadSnapshot,
} from "../reviews/workload-balance";
import {
  compareTr121H02Cooldown as compareTr121H02CooldownProfile,
  tr121H02CooldownProfile,
  type Tr121H02CooldownProfile,
} from "../rules/tr121-h02-cooldown";

export interface CandidatePriority {
  ke166ReservationConflict: boolean;
  dutyPosition: DutyPositionDisposition;
  strictTransitionViolations: number;
  preferredTransitionViolations: number;
  scarceQualification: ScarceQualificationPriority;
  alreadyAssignedToday: boolean;
  lateShiftRecovery: LateShiftRecoveryPriority;
  lateShiftCutoff: LateShiftCutoffPriority;
  repeatedPriorityPosition: boolean;
  repeatedHighFatiguePosition: boolean;
  rollingLoadExcess: number;
  highLoadRecoveryConflict: boolean;
  tr121H02Cooldown: Tr121H02CooldownProfile;
  latePriorityFrequency: LatePriorityFrequencyProfile;
  previousWorkdayLoad: import("../shared/previous-workday-load-model").PreviousWorkdayLoad;
  positionFrequency: {
    currentMonthCount: number;
    recentWorkdayCount: number;
  };
  workloadBalance: {
    violatesConfiguredTarget: boolean;
    todayHoursExcess: number;
    rollingHoursExcess: number;
    todayFatigueExcess: number;
    todayHoursSpread: number;
    rollingHoursSpread: number;
    todayFatigueSpread: number;
  };
  historicalFatigue: number;
}

export function compareNumber(left: number, right: number): number {
  return left - right;
}

const DUTY_POSITION_ORDER: Readonly<
  Record<CandidatePriority["dutyPosition"], number>
> = {
  "reserved-target": 0,
  unrelated: 1,
  "reserved-elsewhere": 2,
};

export function compareScarceQualification(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  const leftHasFutureTask = left.scarceQualification.futureTaskCount > 0;
  const rightHasFutureTask = right.scarceQualification.futureTaskCount > 0;
  if (leftHasFutureTask !== rightHasFutureTask)
    return Number(leftHasFutureTask) - Number(rightHasFutureTask);
  if (!leftHasFutureTask) return 0;
  const minimumEligibleDifference =
    (right.scarceQualification.minimumEligibleStaff ?? 0) -
    (left.scarceQualification.minimumEligibleStaff ?? 0);
  return (
    minimumEligibleDifference ||
    left.scarceQualification.futureTaskCount -
      right.scarceQualification.futureTaskCount
  );
}

/** Snapshot-level hard qualification check for automatic assignments. */
export function assessScarceQualificationSnapshot(
  state: Pick<ScheduleGenerationFacts, "positionRules" | "staff" | "flights">,
  assignments: readonly Assignment[]
): string[] {
  const rules = new Map(state.positionRules.map((rule) => [rule.id, rule]));
  return assignments.flatMap((assignment) => {
    if (assignment.status !== "assigned" || !assignment.staffId) return [];
    if (isGuideAssignment(state, assignment)) return [];
    const rule = assignment.positionRuleId
      ? rules.get(assignment.positionRuleId)
      : undefined;
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    if (!rule || !flight) return [];
    const effectiveRule = administrativeSupportAutomaticRule(state, rule);
    return effectiveRule.qualifiedStaffIds.includes(assignment.staffId)
      ? []
      : [assignment.id];
  });
}

export function compareLateShiftRecovery(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  if (
    left.latePriorityFrequency.targetKinds.includes("supervisor") &&
    right.latePriorityFrequency.targetKinds.includes("supervisor") &&
    compareLatePriorityFrequencyProfileForKind(
      left.latePriorityFrequency,
      right.latePriorityFrequency,
      "supervisor"
    ) !== 0
  )
    return 0;
  return (
    Number(left.lateShiftRecovery.protectedMorningTarget) -
      Number(right.lateShiftRecovery.protectedMorningTarget) ||
    Number(left.lateShiftRecovery.protectedLatePriorityTarget) -
      Number(right.lateShiftRecovery.protectedLatePriorityTarget)
  );
}

export function compareLateShiftCutoff(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  const leftAfterCutoff = left.lateShiftCutoff.disposition === "after-cutoff";
  const rightAfterCutoff = right.lateShiftCutoff.disposition === "after-cutoff";
  if (leftAfterCutoff !== rightAfterCutoff)
    return Number(leftAfterCutoff) - Number(rightAfterCutoff);
  if (!leftAfterCutoff) return 0;
  const leftCutoff = left.lateShiftCutoff.cutoffMinutes ?? 0;
  const rightCutoff = right.lateShiftCutoff.cutoffMinutes ?? 0;
  const leftPreviousEnd = left.lateShiftCutoff.previousEndMinutes ?? 0;
  const rightPreviousEnd = right.lateShiftCutoff.previousEndMinutes ?? 0;
  return rightCutoff - leftCutoff || leftPreviousEnd - rightPreviousEnd;
}

export function compareWorkloadBalance(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    Number(left.workloadBalance.violatesConfiguredTarget) -
      Number(right.workloadBalance.violatesConfiguredTarget) ||
    left.workloadBalance.todayHoursExcess -
      right.workloadBalance.todayHoursExcess ||
    left.workloadBalance.rollingHoursExcess -
      right.workloadBalance.rollingHoursExcess ||
    left.workloadBalance.todayFatigueExcess -
      right.workloadBalance.todayFatigueExcess ||
    left.workloadBalance.todayHoursSpread -
      right.workloadBalance.todayHoursSpread ||
    left.workloadBalance.rollingHoursSpread -
      right.workloadBalance.rollingHoursSpread ||
    left.workloadBalance.todayFatigueSpread -
      right.workloadBalance.todayFatigueSpread
  );
}

export function comparePositionFrequency(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    compareNumber(
      left.positionFrequency.currentMonthCount,
      right.positionFrequency.currentMonthCount
    ) ||
    compareNumber(
      left.positionFrequency.recentWorkdayCount,
      right.positionFrequency.recentWorkdayCount
    )
  );
}

export function compareLatePriorityFrequency(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareLatePriorityFrequencyProfile(
    left.latePriorityFrequency,
    right.latePriorityFrequency
  );
}

export function compareTr121H02Cooldown(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareTr121H02CooldownProfile(
    left.tr121H02Cooldown,
    right.tr121H02Cooldown
  );
}

export function compareLatePriorityAggregateRotation(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    compareLatePriorityCategoryBoundaryProfile(
      left.latePriorityFrequency,
      right.latePriorityFrequency
    ) ||
    compareLatePriorityAggregateProfile(
      left.latePriorityFrequency,
      right.latePriorityFrequency
    )
  );
}

export function compareLatePriorityCategoryBoundary(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareLatePriorityCategoryBoundaryProfile(
    left.latePriorityFrequency,
    right.latePriorityFrequency
  );
}

export function compareLatePriorityPreviousWorkday(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    Number(left.latePriorityFrequency.previousWorkdayAssigned) -
    Number(right.latePriorityFrequency.previousWorkdayAssigned)
  );
}

export function compareLatePriorityAggregateCurrentMonth(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    left.latePriorityFrequency.totalCurrentMonthCount -
    right.latePriorityFrequency.totalCurrentMonthCount
  );
}

export function compareLatePriorityAggregateRecentWorkdays(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    left.latePriorityFrequency.totalRecentWorkdayCount -
    right.latePriorityFrequency.totalRecentWorkdayCount
  );
}

export function compareLatePriorityFrequencyForKind(
  left: CandidatePriority,
  right: CandidatePriority,
  kind: LatePriorityFrequencyKind
): number {
  return compareLatePriorityFrequencyProfileForKind(
    left.latePriorityFrequency,
    right.latePriorityFrequency,
    kind
  );
}

export function comparePreviousWorkdayLoadPriority(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    left.previousWorkdayLoad.fatiguePoints -
      right.previousWorkdayLoad.fatiguePoints ||
    left.previousWorkdayLoad.latestEndMinutes -
      right.previousWorkdayLoad.latestEndMinutes ||
    left.previousWorkdayLoad.workHours - right.previousWorkdayLoad.workHours ||
    left.previousWorkdayLoad.priorityPositionCount -
      right.previousWorkdayLoad.priorityPositionCount
  );
}

export function compareKe166Reservation(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return (
    Number(left.ke166ReservationConflict) -
    Number(right.ke166ReservationConflict)
  );
}

export function compareDutyPosition(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareNumber(
    DUTY_POSITION_ORDER[left.dutyPosition],
    DUTY_POSITION_ORDER[right.dutyPosition]
  );
}

export function compareStrictPositionTransition(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareNumber(
    left.strictTransitionViolations,
    right.strictTransitionViolations
  );
}

export function comparePreferredPositionTransition(
  left: CandidatePriority,
  right: CandidatePriority
): number {
  return compareNumber(
    left.preferredTransitionViolations,
    right.preferredTransitionViolations
  );
}

export interface CandidatePriorityContext {
  state: ScheduleGenerationFacts;
  assignments: Assignment[];
  tasks: AssignmentTask[];
  processedTasks: Set<string>;
  eligibleStaffIds: Map<string, Set<string>>;
  eligibleCounts: Map<string, number>;
  runFacts: ScheduleRunFacts;
  date: string;
  dutyStaffId: string | null;
  task: AssignmentTask;
  hours: number;
  isDutyTarget: boolean;
  reserveDutyForPendingTarget: boolean;
  currentDutyTargetTaskKeys: ReadonlySet<string>;
  workloadBalanceLoads?: readonly WorkloadBalanceLoadSnapshot[];
}

export function buildCandidatePriority(
  context: CandidatePriorityContext,
  person: Staff
): CandidatePriority {
  const {
    state,
    assignments,
    tasks,
    processedTasks,
    eligibleStaffIds,
    eligibleCounts,
    runFacts,
    date,
    dutyStaffId,
    task,
    hours,
    isDutyTarget,
    reserveDutyForPendingTarget,
    currentDutyTargetTaskKeys,
    workloadBalanceLoads,
  } = context;
  const { flight, rule, key: taskKey } = task;
  return {
    ke166ReservationConflict: tasks.some(
      (futureTask) =>
        futureTask.key !== taskKey &&
        !processedTasks.has(futureTask.key) &&
        futureTask.flight.id !== flight.id &&
        isKe166MobileSupervisor(futureTask.flight, futureTask.rule) &&
        eligibleStaffIds.get(futureTask.key)?.has(person.id) &&
        eligibleCounts.get(futureTask.key) === 1 &&
        intervalsOverlap(
          flight.startTime,
          flight.endTime,
          futureTask.flight.startTime,
          futureTask.flight.endTime
        )
    ),
    dutyPosition:
      isDutyTarget || reserveDutyForPendingTarget
        ? dutyPositionPriority(
            person.id,
            taskKey,
            dutyStaffId,
            currentDutyTargetTaskKeys
          )
        : person.id === dutyStaffId &&
            isDutyAfternoonFlight(flight, state.settings)
          ? "reserved-elsewhere"
          : "unrelated",
    strictTransitionViolations: positionTransitionInsertionCost(
      assignments,
      person.id,
      task,
      state,
      "forbid"
    ),
    preferredTransitionViolations: positionTransitionInsertionCost(
      assignments,
      person.id,
      task,
      state,
      "prefer"
    ),
    scarceQualification: isOrdinaryPriorityPosition(
      rule,
      state.settings.ordinaryPriorityPositions
    )
      ? priorityPositionScarceQualification(
          person,
          task,
          state,
          assignments,
          tasks,
          processedTasks,
          eligibleCounts,
          eligibleStaffIds
        )
      : scarceQualificationPriority(
          person,
          flight,
          tasks,
          processedTasks,
          eligibleCounts,
          eligibleStaffIds
        ),
    alreadyAssignedToday: assignments.some(
      (item) => item.staffId === person.id && item.workHours > 0
    ),
    lateShiftRecovery: lateShiftRecoveryPriority(
      state,
      person.id,
      {
        ...flight,
        position: rule.name,
        remark: rule.remark,
        fatiguePoints: rule.fatiguePoints,
      },
      date,
      runFacts.crossDayRecovery
    ),
    lateShiftCutoff: lateShiftCutoffPriority(
      state,
      person.id,
      flight,
      date,
      runFacts.crossDayRecovery
    ),
    repeatedPriorityPosition:
      isOrdinaryPriorityPosition(
        rule,
        state.settings.ordinaryPriorityPositions
      ) &&
      consecutivePositionAssignments(
        state,
        person.id,
        flight.flightNo,
        rule.name,
        rule.remark,
        date,
        runFacts.scheduleFrequency
      ) > 0,
    repeatedHighFatiguePosition:
      isHighFatigueOrdinaryRotationPosition(
        rule,
        state.settings.highLoadFatigueThreshold,
        state.settings.ordinaryPriorityPositions
      ) &&
      consecutivePositionAssignments(
        state,
        person.id,
        flight.flightNo,
        rule.name,
        rule.remark,
        date,
        runFacts.scheduleFrequency
      ) > 0,
    rollingLoadExcess: rollingLoadCost(
      assignments,
      person.id,
      flight.startTime,
      rule.fatiguePoints,
      rule.remark,
      state
    ),
    highLoadRecoveryConflict:
      state.settings.highLoadProtectionEnabled &&
      hasHighLoadTransition(
        assignments,
        person.id,
        flight.startTime,
        flight.endTime,
        rule.fatiguePoints,
        rule.remark,
        state
      ),
    tr121H02Cooldown: tr121H02CooldownProfile(
      state,
      person.id,
      flight.flightNo,
      rule,
      date,
      runFacts.scheduleFrequency
    ),
    latePriorityFrequency: latePriorityFrequencyProfileForRule(
      state,
      person.id,
      flight,
      rule,
      date,
      runFacts.scheduleFrequency
    ),
    previousWorkdayLoad: previousWorkdayLoadForStaff(
      runFacts.previousWorkdayLoad,
      person.id
    ),
    positionFrequency: positionFrequencyProfileForRule(
      state,
      person.id,
      flight.flightNo,
      rule,
      date,
      runFacts.scheduleFrequency
    ),
    workloadBalance: workloadBalancePriority(
      person,
      assignments,
      state,
      hours,
      rule.fatiguePoints,
      dutyStaffId,
      date,
      runFacts.workloadPressure,
      workloadBalanceLoads
    ),
    historicalFatigue: totalFatiguePriority(
      person,
      assignments,
      state,
      date,
      dutyStaffId,
      runFacts.historicalFatigueByStaff.get(person.id)
    ),
  };
}
