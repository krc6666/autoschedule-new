import {
  isSupervisorFillTarget,
  supervisorFillRelationsForTarget,
} from "../coverage/supervisor-fill-configuration";
import type { Assignment, PositionRule } from "../../model";
import type { AssignmentEligibilityFacts } from "../shared/scheduling-facts";
import { clearAutomaticAssignmentEvidence } from "./assignment-evidence";
import { durationHours } from "../shared/time";
import { evaluateMobileSupervisorCoverage } from "../coverage/mobile-supervisor-coverage";
import {
  clearSupervisorFillLink,
  clearSupervisorFillRule,
  evaluateSupervisorFillFacts,
  hasRecordedSupervisorFillLink,
  setSupervisorFillLink,
} from "../coverage/supervisor-fill-facts";

function assignmentRule(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): PositionRule | undefined {
  return assignment.positionRuleId
    ? state.positionRules.find((rule) => rule.id === assignment.positionRuleId)
    : undefined;
}

function emptyStatus(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): Assignment["status"] {
  const rule = assignmentRule(state, assignment);
  return !assignment.positionRuleId ||
    rule?.manual ||
    rule?.category === "行政支援"
    ? "manual"
    : "unfilled";
}

export function isSupervisorAssignment(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): boolean {
  return assignmentRule(state, assignment)?.category === "机动督导";
}

function supervisorSource(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): Assignment | undefined {
  if (isSupervisorAssignment(state, assignment)) return assignment;
  return assignment.supervisorSourceAssignmentId
    ? state.assignments.find(
        (item) => item.id === assignment.supervisorSourceAssignmentId
      )
    : undefined;
}

function resetSupervisorLinkedAssignment(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): void {
  const hadSourceLink = Boolean(assignment.supervisorSourceAssignmentId);
  clearSupervisorFillLink(assignment);
  if (!hadSourceLink) return;
  const flight = state.flights.find((item) => item.id === assignment.flightId);
  const rule = assignmentRule(state, assignment);
  assignment.staffId = null;
  assignment.staffName = "";
  assignment.status = emptyStatus(state, assignment);
  assignment.workHours = flight
    ? durationHours(flight.startTime, flight.endTime)
    : assignment.workHours;
  assignment.fatiguePoints = rule?.fatiguePoints ?? assignment.workHours;
  clearAutomaticAssignmentEvidence(assignment);
}

export function moveSupervisorWithinFlight(
  state: AssignmentEligibilityFacts,
  sourceAssignmentId: string,
  targetAssignmentId: string
): string | null {
  const source = state.assignments.find(
    (assignment) => assignment.id === sourceAssignmentId
  );
  const target = state.assignments.find(
    (assignment) => assignment.id === targetAssignmentId
  );
  if (!source || !target) return "源岗位或目标岗位不存在";
  const supervisor = supervisorSource(state, source);
  if (!supervisor || !isSupervisorAssignment(state, supervisor))
    return "仅督导可在同一航班内机动补位";
  const configuredFill = evaluateSupervisorFillFacts(
    state,
    state.assignments,
    supervisor,
    target,
    "manual"
  );
  const targetRule = assignmentRule(state, target);
  if (isSupervisorFillTarget(state, targetRule) && !configuredFill.allowed)
    return `机动督导不能补位 ${target.flightNo}/${target.position}：${configuredFill.reason}`;
  if (supervisor.flightId !== target.flightId && !configuredFill.allowed)
    return `机动督导不能补位 ${target.flightNo}/${target.position}：${configuredFill.reason}`;
  if (isSupervisorAssignment(state, target))
    return "航班顶部督导岗位固定，不能作为补位目标";
  if (
    !supervisor.staffId ||
    !supervisor.staffName ||
    supervisor.status !== "assigned"
  )
    return "顶部督导尚未安排人员";
  if (target.staffId || target.staffName)
    return `目标岗位已有人员，请先清空 ${target.position}`;
  if (supervisor.flightId === target.flightId && !configuredFill.allowed) {
    const coverage = evaluateMobileSupervisorCoverage(state, {
      flightNo: target.flightNo,
      position: target.position,
      remark: target.remark,
    });
    if (!coverage.allowed)
      return `机动督导不能兼任 ${target.flightNo}/${target.position}：${coverage.reason}`;
  }
  const person = state.staff.find((item) => item.id === supervisor.staffId);
  if (!person) return "督导人员不存在";
  if (person.status !== "正常")
    return `${person.name} 当前状态为${person.status}`;

  if (source.id !== supervisor.id)
    resetSupervisorLinkedAssignment(state, source);
  target.staffId = supervisor.staffId;
  target.staffName = supervisor.staffName;
  target.status = "assigned";
  target.workHours = 0;
  target.fatiguePoints = configuredFill.allowed
    ? 0
    : (targetRule?.fatiguePoints ?? 0);
  setSupervisorFillLink(
    target,
    supervisor.id,
    configuredFill.allowed ? configuredFill.rule?.id : undefined
  );
  clearAutomaticAssignmentEvidence(target);
  return null;
}

export function clearSupervisorLink(
  state: AssignmentEligibilityFacts,
  assignment: Assignment
): void {
  resetSupervisorLinkedAssignment(state, assignment);
}

export function normalizeSupervisorAssignments(
  state: AssignmentEligibilityFacts
): void {
  state.assignments.forEach((assignment) => {
    let source = assignment.supervisorSourceAssignmentId
      ? state.assignments.find(
          (item) => item.id === assignment.supervisorSourceAssignmentId
        )
      : undefined;
    const inferredConfiguredFillSource =
      !source &&
      isSupervisorFillTarget(state, assignmentRule(state, assignment))
        ? state.assignments.find(
            (candidate) =>
              candidate.flightId === assignment.flightId &&
              candidate.staffId === assignment.staffId &&
              candidate.status === "assigned" &&
              isSupervisorAssignment(state, candidate)
          )
        : undefined;
    if (inferredConfiguredFillSource) source = inferredConfiguredFillSource;
    const inferredFillEvaluation = inferredConfiguredFillSource
      ? evaluateSupervisorFillFacts(
          state,
          state.assignments,
          inferredConfiguredFillSource,
          assignment,
          "manual",
          { ignoreSafeRegularCandidate: true }
        )
      : undefined;
    const configuredFill = inferredFillEvaluation?.allowed
      ? true
      : source
        ? (["automatic", "manual"] as const).some((mode) => {
            const evaluation = evaluateSupervisorFillFacts(
              state,
              state.assignments,
              source,
              assignment,
              mode,
              { ignoreSafeRegularCandidate: true }
            );
            return hasRecordedSupervisorFillLink(evaluation, assignment);
          })
        : false;
    if (inferredConfiguredFillSource && inferredFillEvaluation?.allowed) {
      setSupervisorFillLink(
        assignment,
        inferredConfiguredFillSource.id,
        inferredFillEvaluation.rule?.id
      );
    }
    const valid = Boolean(
      source &&
      isSupervisorAssignment(state, source) &&
      source.staffId &&
      source.staffName &&
      source.status === "assigned" &&
      (configuredFill ||
        (source.flightId === assignment.flightId &&
          !supervisorFillRelationsForTarget(
            state,
            assignmentRule(state, assignment)
          ).some((rule) => rule.requiresConfirmation) &&
          evaluateMobileSupervisorCoverage(state, {
            flightNo: assignment.flightNo,
            position: assignment.position,
            remark: assignment.remark,
          }).allowed))
    );
    if (!valid || !source) {
      resetSupervisorLinkedAssignment(state, assignment);
      return;
    }
    if (!configuredFill) clearSupervisorFillRule(assignment);
    const rule = assignmentRule(state, assignment);
    const changed =
      assignment.staffId !== source.staffId ||
      assignment.staffName !== source.staffName;
    assignment.staffId = source.staffId;
    assignment.staffName = source.staffName;
    assignment.status = "assigned";
    assignment.workHours = 0;
    assignment.fatiguePoints = configuredFill ? 0 : (rule?.fatiguePoints ?? 0);
    if (changed) clearAutomaticAssignmentEvidence(assignment);
  });
}
