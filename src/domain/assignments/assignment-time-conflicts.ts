import { isSupervisorFillTarget } from "../coverage/supervisor-fill-configuration";
import type { Assignment } from "../../model";
import { assignmentConflictFacts } from "../candidates/assignment-eligibility-facts";
import { canMobileSupervisorCoverPosition } from "../coverage/mobile-supervisor-coverage";
import {
  evaluateSupervisorFillFacts,
  hasRecordedSupervisorFillLink,
  type SupervisorFillMode,
} from "../coverage/supervisor-fill-facts";
import {
  concurrentOverlapMinutes,
  isConcurrentSupervisor,
} from "../coverage/team-leader-concurrent-plan";
import {
  assignmentRule,
  isLegalGuideReuse,
} from "../flights/schedule-position-rules";
import {
  isMobileSupervisor,
  isNumberedRegularPosition,
} from "../flights/schedule-tasks";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";

export type ConcurrentAssignmentMode = SupervisorFillMode | "either";

function hasValidSupervisorFillLink(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  supervisor: Assignment,
  target: Assignment,
  mode: ConcurrentAssignmentMode
): boolean {
  const modes: readonly SupervisorFillMode[] =
    mode === "either" ? ["automatic", "manual"] : [mode];
  return modes.some((candidateMode) =>
    hasRecordedSupervisorFillLink(
      evaluateSupervisorFillFacts(
        state,
        assignments,
        supervisor,
        target,
        candidateMode,
        { ignoreSafeRegularCandidate: true }
      ),
      target
    )
  );
}

export function isControlledConcurrentAssignmentPair(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  left: Assignment,
  right: Assignment,
  supervisorFillMode: ConcurrentAssignmentMode = "automatic"
): boolean {
  if (!left.staffId || left.staffId !== right.staffId) return false;
  const leftRule = assignmentRule(state, left);
  const rightRule = assignmentRule(state, right);
  const leftFlight = state.flights.find(
    (flight) => flight.id === left.flightId
  );
  const rightFlight = state.flights.find(
    (flight) => flight.id === right.flightId
  );
  if (!leftRule || !rightRule || !leftFlight || !rightFlight) return false;

  const target =
    left.supervisorSourceAssignmentId === right.id
      ? left
      : right.supervisorSourceAssignmentId === left.id
        ? right
        : undefined;
  const supervisor =
    target === left ? right : target === right ? left : undefined;
  const targetRule =
    target === left ? leftRule : target === right ? rightRule : undefined;
  const supervisorRule =
    supervisor === left
      ? leftRule
      : supervisor === right
        ? rightRule
        : undefined;
  const supervisorFlight =
    supervisor === left
      ? leftFlight
      : supervisor === right
        ? rightFlight
        : undefined;
  if (
    target &&
    supervisor &&
    targetRule &&
    supervisorRule &&
    supervisorFlight &&
    target.flightId === supervisor.flightId &&
    (isSupervisorFillTarget(state, targetRule) || target.supervisorFillRuleId
      ? hasValidSupervisorFillLink(
          state,
          assignments,
          supervisor,
          target,
          supervisorFillMode
        )
      : isNumberedRegularPosition(targetRule) &&
        isMobileSupervisor(supervisorFlight, supervisorRule) &&
        canMobileSupervisorCoverPosition(state, {
          flightNo: target.flightNo,
          position: target.position,
          remark: target.remark,
        }))
  ) {
    return true;
  }

  const person = state.staff.find((item) => item.id === left.staffId);
  const hasConcurrentDecision = [left, right].every((assignment) =>
    assignment.decisionTrace?.some(
      (decision) =>
        decision.ruleId === "team-leader-concurrent-supervision" &&
        decision.outcome === "selected"
    )
  );
  if (
    !person?.teamLeader ||
    !hasConcurrentDecision ||
    left.flightId === right.flightId ||
    !isConcurrentSupervisor(leftRule, leftFlight) ||
    !isConcurrentSupervisor(rightRule, rightFlight)
  ) {
    return false;
  }
  const overlapMinutes = concurrentOverlapMinutes(state, left, right);
  return (
    overlapMinutes > 0 &&
    overlapMinutes <=
      state.settings.teamLeaderConcurrentSupervisionMaxOverlapMinutes
  );
}

export function isAllowedAssignmentTimeOverlap(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[],
  left: Assignment,
  right: Assignment
): boolean {
  if (!left.staffId || left.staffId !== right.staffId) return false;
  if (isLegalGuideReuse(state, left, right)) return true;
  return isControlledConcurrentAssignmentPair(
    state,
    assignments,
    left,
    right,
    "either"
  );
}

export function timeConflictAssignmentIds(
  state: ScheduleGenerationFacts,
  assignments: readonly Assignment[]
): Set<string> {
  const assigned = assignments.filter((assignment) => assignment.staffId);
  const conflictIds = new Set<string>();
  for (const assignment of assigned) {
    const person = state.staff.find(
      (candidate) => candidate.id === assignment.staffId
    );
    const flight = state.flights.find(
      (candidate) => candidate.id === assignment.flightId
    );
    if (!person || !flight) continue;
    const assignmentWindow = {
      id: assignment.flightId,
      startTime: assignment.startTime,
      endTime: assignment.endTime,
    };
    const conflicts = assignmentConflictFacts({
      state,
      assignments: assigned.filter(
        (candidate) => candidate.id !== assignment.id
      ),
      assignment,
      flight: assignmentWindow,
      rule: assignmentRule(state, assignment),
      person,
      sameFlightConflict: "block",
    }).blockingConflicts;
    for (const conflict of conflicts) {
      if (
        isAllowedAssignmentTimeOverlap(state, assigned, assignment, conflict)
      ) {
        continue;
      }
      conflictIds.add(assignment.id);
      conflictIds.add(conflict.id);
    }
  }
  return conflictIds;
}
