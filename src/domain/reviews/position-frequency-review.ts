import type { Assignment, Staff } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import {
  rebuildAutomaticAssignmentEvidence,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import { isOrdinaryPriorityPosition } from "./position-rotation-policy";
import {
  comparePositionFrequency,
  createScheduleFrequencyFacts,
  POSITION_FREQUENCY_WORKDAY_COUNT,
  positionFrequencyProfileForAssignment,
  type PositionFrequencyProfile,
  type ScheduleFrequencyFacts,
} from "../statistics/schedule-frequency";
import { assignmentRule } from "../flights/schedule-position-rules";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import {
  isRotationLocked,
  rotationCandidateAssignments,
  type RotationStaffChange,
} from "./rotation-review-safety";
import { optimizeReassignment } from "../solver/reassignment-optimizer";
import type { SolverPort } from "../solver/solver-port";
import {
  assessPositionFrequencyAlert,
  type PositionFrequencyAlertAssessment,
} from "./position-frequency-alert";
import { assignmentWarningMessage } from "./schedule-warning-message";

function frequencyProfileText(profile: PositionFrequencyProfile): string {
  return `本月${profile.currentMonthCount}次、最近${POSITION_FREQUENCY_WORKDAY_COUNT}个已归档工作日${profile.recentWorkdayCount}次`;
}

function alertPeriods(assessment: PositionFrequencyAlertAssessment) {
  return assessment.periods.filter((period) => period.difference >= 2);
}

function frequencyAlertFact(
  primary: Assignment,
  assessment: PositionFrequencyAlertAssessment
): string {
  const periods = assessment.soleQualified
    ? assessment.periods.filter((period) => period.assignedCount >= 3)
    : alertPeriods(assessment);
  const counts = periods
    .map((period) => `${period.label}承担${period.assignedCount}次`)
    .join("、");
  const difference = Math.max(...periods.map((period) => period.difference));
  const comparison = assessment.soleQualified
    ? "当前只有这一名合格人员"
    : `合格人员最高与最低最多相差${difference}次`;
  return `在${primary.flightNo}/${primary.position}${counts}，${comparison}`;
}

function applyFrequencyAlertEvidence(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  date: string,
  attemptedReasons: ReadonlyMap<string, readonly string[]>,
  frequencyFacts: ScheduleFrequencyFacts
): string[] {
  const warnings: string[] = [];
  for (const assignment of assignments) {
    const rule = assignmentRule(state, assignment);
    if (
      !rule ||
      !isOrdinaryPriorityPosition(
        rule,
        state.settings.ordinaryPriorityPositions
      ) ||
      assignment.status !== "assigned" ||
      !assignment.staffId
    )
      continue;
    const assessment = assessPositionFrequencyAlert(
      state,
      assignment,
      date,
      frequencyFacts
    );
    if (!assessment?.needsAttention) {
      const existing = assignment.decisionTrace?.filter(
        (decision) => decision.ruleId === "position-frequency-review"
      );
      if (existing?.some((decision) => decision.outcome === "fallback"))
        replaceAssignmentDecisions(assignment, "position-frequency-review", []);
      continue;
    }
    if (assessment.improving) {
      const difference = Math.max(
        ...alertPeriods(assessment).map((period) => period.difference)
      );
      const message = `${assignment.staffName} 本班承担${assignment.flightNo}/${assignment.position}，累计最高与最低仍相差${difference}次。本班已安排给低频人员，差距正在改善。`;
      replaceAssignmentDecisions(assignment, "position-frequency-review", [
        schedulingDecision("position-frequency-review", "selected", message),
      ]);
      continue;
    }
    const reasons = assessment.soleQualified
      ? ["无其他具备目标岗位资质的人员"]
      : (attemptedReasons.get(assignment.id) ?? [
          "前序排班安排优先，未能改由最低频人员",
        ]);
    const message = assignmentWarningMessage({
      staffName: assignment.staffName,
      fact: frequencyAlertFact(assignment, assessment),
      reasons,
      result: assessment.soleQualified
        ? "保留原安排，请关注岗位人员储备"
        : "保留原安排",
    });
    replaceAssignmentDecisions(assignment, "position-frequency-review", [
      schedulingDecision("position-frequency-review", "fallback", message),
    ]);
    warnings.push(message);
  }
  return warnings;
}

function candidateFrequencyOrder(
  state: ScheduleGenerationFacts,
  primary: Assignment,
  date: string,
  facts: ScheduleFrequencyFacts
): (left: Staff, right: Staff) => number {
  return (left, right) =>
    comparePositionFrequency(
      positionFrequencyProfileForAssignment(
        state,
        primary,
        left.id,
        date,
        facts
      ),
      positionFrequencyProfileForAssignment(
        state,
        primary,
        right.id,
        date,
        facts
      )
    ) || left.id.localeCompare(right.id, undefined, { numeric: true });
}

function applyFrequencyPlan(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  primary: Assignment,
  profile: PositionFrequencyProfile,
  changes: readonly RotationStaffChange[]
): void {
  const originalById = new Map(
    assignments.map((assignment) => [
      assignment.id,
      {
        staffId: assignment.staffId!,
        staffName: assignment.staffName,
        flightNo: assignment.flightNo,
        position: assignment.position,
      },
    ])
  );
  const originalPrimary = originalById.get(primary.id)!;
  const changedAssignments: Assignment[] = [];
  for (const change of changes) {
    const assignment = assignments.find(
      (item) => item.id === change.assignmentId
    );
    const person = state.staff.find((item) => item.id === change.staffId);
    if (!assignment || !person) continue;
    assignment.staffId = person.id;
    assignment.staffName = person.name;
    changedAssignments.push(assignment);
  }
  const participants = new Set(
    changes.flatMap((change) => [
      originalById.get(change.assignmentId)!.staffId,
      change.staffId,
    ])
  ).size;
  const route = changedAssignments
    .map(
      (assignment) =>
        `${assignment.staffName}接${assignment.flightNo}/${assignment.position}`
    )
    .join(" → ");
  const message = `${originalPrimary.staffName}${frequencyProfileText(profile)}承担${originalPrimary.flightNo}/${originalPrimary.position}，本班已通过${participants}人整体安全重排降低同岗频率：${route}；岗位完整性及全部安全约束验证通过。`;
  changedAssignments.forEach((assignment) => {
    rebuildAutomaticAssignmentEvidence(assignment, [
      schedulingDecision("position-frequency-review", "selected", message),
    ]);
  });
}

export async function reviewSamePositionFrequency(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  date: string,
  lockedAssignmentIds: ReadonlySet<string>,
  facts?: ScheduleRunFacts
): Promise<string[]> {
  if (!state.settings.positionRotationEnabled) return [];
  assignments.forEach((assignment) =>
    replaceAssignmentDecisions(assignment, "position-frequency-review", [])
  );
  const frequencyFacts =
    facts?.scheduleFrequency ?? createScheduleFrequencyFacts(state, date);
  const attemptedReasonsByAssignment = new Map<string, readonly string[]>();
  const reviewed = new Set<string>();
  const primaryAssignments = assignments
    .filter(
      (assignment) => !isRotationLocked(state, assignment, lockedAssignmentIds)
    )
    .filter((assignment) => {
      const rule = assignmentRule(state, assignment);
      return Boolean(
        rule &&
        isOrdinaryPriorityPosition(
          rule,
          state.settings.ordinaryPriorityPositions
        )
      );
    })
    .map((assignment) => ({
      assignment,
      frequency: positionFrequencyProfileForAssignment(
        state,
        assignment,
        assignment.staffId!,
        date,
        frequencyFacts
      ),
    }))
    .sort(
      (left, right) =>
        right.frequency.currentMonthCount - left.frequency.currentMonthCount ||
        right.frequency.recentWorkdayCount -
          left.frequency.recentWorkdayCount ||
        left.assignment.flightNo.localeCompare(right.assignment.flightNo) ||
        left.assignment.position.localeCompare(right.assignment.position)
    );

  for (const { assignment: primary } of primaryAssignments) {
    if (reviewed.has(primary.id) || !primary.staffId) continue;
    const frequency = positionFrequencyProfileForAssignment(
      state,
      primary,
      primary.staffId,
      date,
      frequencyFacts
    );
    const rule = assignmentRule(state, primary);
    if (!rule) continue;
    const configuredOthers = state.staff.filter(
      (person) =>
        person.id !== primary.staffId &&
        person.staffType === "常规" &&
        rule.qualifiedStaffIds.includes(person.id)
    );
    const lowerFrequencyConfigured = configuredOthers.filter(
      (person) =>
        comparePositionFrequency(
          positionFrequencyProfileForAssignment(
            state,
            primary,
            person.id,
            date,
            frequencyFacts
          ),
          frequency
        ) < 0
    );
    if (!lowerFrequencyConfigured.length) {
      attemptedReasonsByAssignment.set(primary.id, [
        configuredOthers.length
          ? "无其他同岗频率更低且具备目标岗位资质的人员"
          : "无其他具备目标岗位资质的人员",
      ]);
      reviewed.add(primary.id);
      continue;
    }
    const lowerFrequencyIds = new Set(
      lowerFrequencyConfigured.map((person) => person.id)
    );
    const compareStaff = candidateFrequencyOrder(
      state,
      primary,
      date,
      frequencyFacts
    );
    const result = await optimizeReassignment({
      solver,
      state,
      assignments,
      primary,
      movableAssignments: rotationCandidateAssignments(
        assignments,
        primary,
        state,
        lockedAssignmentIds
      ).filter((assignment) => !reviewed.has(assignment.id)),
      date,
      facts,
      frequencyFacts,
      intent: { kind: "position-frequency-review" },
      primaryCandidateAllowed: (person) => lowerFrequencyIds.has(person.id),
      compareCandidates: (_assignment, left, right) =>
        compareStaff(left, right),
      maxParticipants: 5,
    });
    if (result.changes) {
      applyFrequencyPlan(
        state,
        assignments,
        primary,
        frequency,
        result.changes
      );
      result.changes.forEach((change) => reviewed.add(change.assignmentId));
      continue;
    }
    const lockedNames = lowerFrequencyConfigured
      .filter((person) =>
        assignments.some(
          (assignment) =>
            assignment.staffId === person.id &&
            isRotationLocked(state, assignment, lockedAssignmentIds)
        )
      )
      .map((person) => person.name);
    const reasons = [...result.attemptedReasons];
    if (lockedNames.length)
      reasons.push(
        `其他低频人员被值班或KE166特殊锁定：${lockedNames.join("、")}`
      );
    attemptedReasonsByAssignment.set(primary.id, reasons);
    reviewed.add(primary.id);
  }
  return applyFrequencyAlertEvidence(
    state,
    assignments,
    date,
    attemptedReasonsByAssignment,
    frequencyFacts
  );
}
