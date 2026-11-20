import { flightRuleSettings } from "../flights/flight-rule-settings";
import type { Assignment, Flight, Staff } from "../../model";
import type {
  ScheduleGenerationFacts,
  ScheduleSettingsFacts,
} from "../shared/scheduling-facts";
import {
  crossDayRecoveryRisk,
  nextWorkdayCutoffProtection,
  type CrossDayRecoveryFacts,
} from "./cross-day-recovery";
import { getDutyRosterForDate } from "../duty-roster/roster";
import { historyFatigue } from "../statistics/fatigue";
import type { AssignmentTask } from "../flights/schedule-tasks";
import { timeToMinutes } from "../shared/time";
import {
  countedWorkloadAssignments,
  isCountedWorkloadAssignment,
} from "../shared/workload-accounting";

export interface LateShiftRecoveryPriority {
  protectedMorningTarget: boolean;
  protectedLatePriorityTarget: boolean;
}

export interface LateShiftCutoffPriority {
  disposition: "unprotected" | "before-cutoff" | "after-cutoff";
  cutoffMinutes: number | null;
  previousEndMinutes: number | null;
}

export function totalFatiguePriority(
  person: Staff,
  assignments: Assignment[],
  state: ScheduleGenerationFacts,
  date: string,
  dutyStaffId?: string | null,
  knownHistoricalFatigue?: number
): number {
  const prior =
    knownHistoricalFatigue ??
    historyFatigue(state.history, person.id, date, state.settings);
  const current = countedWorkloadAssignments(state, assignments)
    .filter((assignment) => assignment.staffId === person.id)
    .reduce((sum, assignment) => sum + assignment.fatiguePoints, 0);
  const resolvedDutyStaffId =
    dutyStaffId === undefined
      ? getDutyRosterForDate(state, date).dutyStaffId
      : dutyStaffId;
  const dutyFatigue =
    resolvedDutyStaffId === person.id ? state.settings.dutyFatiguePoints : 0;
  return prior + current + dutyFatigue;
}

export function isHighLoadPosition(
  fatiguePoints: number,
  remark: string,
  state: ScheduleGenerationFacts
): boolean {
  return (
    fatiguePoints >= state.settings.highLoadFatigueThreshold ||
    (state.settings.remarkedPositionHighLoad && Boolean(remark.trim()))
  );
}

function recoveryGapMinutes(
  previous: Pick<Assignment, "startTime" | "endTime">,
  nextStartTime: string
): number {
  const previousStart = timeToMinutes(previous.startTime);
  let previousEnd = timeToMinutes(previous.endTime);
  let nextStart = timeToMinutes(nextStartTime);
  if (previousEnd <= previousStart) previousEnd += 24 * 60;
  if (nextStart < previousStart) nextStart += 24 * 60;
  return nextStart - previousEnd;
}

export function hasHighLoadTransition(
  assignments: Assignment[],
  staffId: string,
  nextStartTime: string,
  nextEndTime: string,
  nextFatiguePoints: number,
  nextRemark: string,
  state: ScheduleGenerationFacts
): boolean {
  if (
    !state.settings.highLoadProtectionEnabled ||
    !isHighLoadPosition(nextFatiguePoints, nextRemark, state)
  )
    return false;
  return assignments.some((assignment) => {
    if (
      assignment.staffId !== staffId ||
      assignment.status !== "assigned" ||
      !isCountedWorkloadAssignment(state, assignment) ||
      !isHighLoadPosition(assignment.fatiguePoints, assignment.remark, state)
    )
      return false;
    const assignmentStartsFirst =
      timeToMinutes(assignment.startTime) <= timeToMinutes(nextStartTime);
    const gap = assignmentStartsFirst
      ? recoveryGapMinutes(assignment, nextStartTime)
      : recoveryGapMinutes(
          { startTime: nextStartTime, endTime: nextEndTime },
          assignment.startTime
        );
    return gap >= 0 && gap <= state.settings.highLoadRecoveryMinutes;
  });
}

export function normalizedPolicyValue(value: string): string {
  return value.trim().toUpperCase();
}

export function positionTransitionCost(
  assignments: Assignment[],
  staffId: string,
  targetFlightNo: string,
  targetPosition: string,
  targetStartTime: string,
  state: ScheduleSettingsFacts,
  mode: "prefer" | "forbid"
): number {
  return violatedPositionTransitionPolicies(
    assignments,
    staffId,
    targetFlightNo,
    targetPosition,
    targetStartTime,
    state,
    mode
  ).length;
}

export function violatedPositionTransitionPolicies(
  assignments: Assignment[],
  staffId: string,
  targetFlightNo: string,
  targetPosition: string,
  targetStartTime: string,
  state: ScheduleSettingsFacts,
  mode: "prefer" | "forbid"
) {
  const targetFlight = normalizedPolicyValue(targetFlightNo);
  const targetRole = normalizedPolicyValue(targetPosition);
  return flightRuleSettings(state)
    .positionTransitionPolicies.filter(
      (policy) =>
        policy.enabled &&
        policy.mode === mode &&
        normalizedPolicyValue(policy.targetFlightNo) === targetFlight &&
        normalizedPolicyValue(policy.targetPosition) === targetRole
    )
    .filter((policy) =>
      assignments.some((assignment) => {
        if (assignment.staffId !== staffId || assignment.status !== "assigned")
          return false;
        if (
          policy.sourceFlightNo.trim() &&
          normalizedPolicyValue(policy.sourceFlightNo) !==
            normalizedPolicyValue(assignment.flightNo)
        )
          return false;
        if (
          policy.sourcePositions.length &&
          !policy.sourcePositions.some(
            (position) =>
              normalizedPolicyValue(position) ===
              normalizedPolicyValue(assignment.position)
          )
        )
          return false;
        const gap = recoveryGapMinutes(assignment, targetStartTime);
        return gap >= 0 && gap < policy.minimumGapMinutes;
      })
    );
}

export function violatedPositionTransitionPoliciesForInsertion(
  assignments: Assignment[],
  staffId: string,
  flightNo: string,
  position: string,
  startTime: string,
  endTime: string,
  state: ScheduleSettingsFacts,
  mode: "prefer" | "forbid"
) {
  const forward = violatedPositionTransitionPolicies(
    assignments,
    staffId,
    flightNo,
    position,
    startTime,
    state,
    mode
  );
  const sourceFlight = normalizedPolicyValue(flightNo);
  const sourcePosition = normalizedPolicyValue(position);
  const reverse = flightRuleSettings(state)
    .positionTransitionPolicies.filter(
      (policy) => policy.enabled && policy.mode === mode
    )
    .filter(
      (policy) =>
        (!policy.sourceFlightNo.trim() ||
          normalizedPolicyValue(policy.sourceFlightNo) === sourceFlight) &&
        (!policy.sourcePositions.length ||
          policy.sourcePositions.some(
            (item) => normalizedPolicyValue(item) === sourcePosition
          ))
    )
    .filter((policy) =>
      assignments.some(
        (assignment) =>
          assignment.staffId === staffId &&
          assignment.status === "assigned" &&
          normalizedPolicyValue(assignment.flightNo) ===
            normalizedPolicyValue(policy.targetFlightNo) &&
          normalizedPolicyValue(assignment.position) ===
            normalizedPolicyValue(policy.targetPosition) &&
          recoveryGapMinutes({ startTime, endTime }, assignment.startTime) >=
            0 &&
          recoveryGapMinutes({ startTime, endTime }, assignment.startTime) <
            policy.minimumGapMinutes
      )
    );
  return [
    ...new Map(
      [...forward, ...reverse].map((policy) => [policy.id, policy])
    ).values(),
  ];
}

export function positionTransitionInsertionCost(
  assignments: Assignment[],
  staffId: string,
  task: AssignmentTask,
  state: ScheduleSettingsFacts,
  mode: "prefer" | "forbid"
): number {
  return violatedPositionTransitionPoliciesForInsertion(
    assignments,
    staffId,
    task.flight.flightNo,
    task.rule.name,
    task.flight.startTime,
    task.flight.endTime,
    state,
    mode
  ).length;
}

export function rollingLoadCost(
  assignments: Assignment[],
  staffId: string,
  targetStartTime: string,
  targetFatiguePoints: number,
  targetRemark: string,
  state: ScheduleGenerationFacts
): number {
  if (
    !state.settings.rollingLoadProtectionEnabled ||
    !isHighLoadPosition(targetFatiguePoints, targetRemark, state)
  )
    return 0;
  const recentFatigue = assignments
    .filter(
      (assignment) =>
        assignment.staffId === staffId && assignment.status === "assigned"
    )
    .filter((assignment) => isCountedWorkloadAssignment(state, assignment))
    .filter((assignment) => {
      const gap = recoveryGapMinutes(assignment, targetStartTime);
      return gap >= 0 && gap <= state.settings.rollingLoadWindowMinutes;
    })
    .reduce((sum, assignment) => sum + assignment.fatiguePoints, 0);
  return Math.max(
    0,
    recentFatigue + targetFatiguePoints - state.settings.rollingLoadMaxFatigue
  );
}

export function lateShiftRecoveryRisk(
  state: ScheduleGenerationFacts,
  staffId: string,
  target: Pick<Flight, "flightNo" | "startTime" | "endTime"> & {
    position: string;
    remark: string;
    fatiguePoints: number;
  },
  date: string | null,
  facts?: CrossDayRecoveryFacts
): {
  protected: boolean;
  excess: number;
  protectedMorningTarget: boolean;
  protectedLatePriorityTarget: boolean;
} {
  const risk = crossDayRecoveryRisk(state, staffId, target, date, facts);
  return {
    protected: risk.protectedWorker,
    excess: risk.protectedWorker ? 1 : 0,
    protectedMorningTarget: risk.protectedMorningTarget,
    protectedLatePriorityTarget: risk.protectedLatePriorityTarget,
  };
}

export function lateShiftRecoveryPriority(
  state: ScheduleGenerationFacts,
  staffId: string,
  target: Pick<Flight, "flightNo" | "startTime" | "endTime"> & {
    position: string;
    remark: string;
    fatiguePoints: number;
  },
  date: string | null,
  facts?: CrossDayRecoveryFacts
): LateShiftRecoveryPriority {
  const risk = lateShiftRecoveryRisk(state, staffId, target, date, facts);
  return {
    protectedMorningTarget: risk.protectedMorningTarget,
    protectedLatePriorityTarget: risk.protectedLatePriorityTarget,
  };
}

export function lateShiftCutoffPriority(
  state: ScheduleGenerationFacts,
  staffId: string,
  target: Pick<Flight, "startTime">,
  date: string | null,
  facts?: CrossDayRecoveryFacts
): LateShiftCutoffPriority {
  const protection = nextWorkdayCutoffProtection(state, staffId, date, facts);
  if (!protection) {
    return {
      disposition: "unprotected",
      cutoffMinutes: null,
      previousEndMinutes: null,
    };
  }
  const targetStart = timeToMinutes(target.startTime);
  const nightEnd = timeToMinutes(state.settings.nightEnd);
  const operationalStart =
    targetStart < nightEnd ? targetStart + 24 * 60 : targetStart;
  return {
    disposition:
      operationalStart >= protection.cutoffMinutes
        ? "after-cutoff"
        : "before-cutoff",
    cutoffMinutes: protection.cutoffMinutes,
    previousEndMinutes: protection.previousEndMinutes,
  };
}
