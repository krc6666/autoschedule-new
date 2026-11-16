import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import {
  rebuildAutomaticAssignmentEvidence,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import { applyConfiguredEarlyReleases } from "../assignments/assignment-timing";
import { findConsecutiveRotationPlan } from "./consecutive-rotation-plan";
import { historyFatigue } from "../statistics/fatigue";
import { reviewMobileSupervisorGroupRotation } from "./mobile-supervisor-rotation-review";
import {
  isHighFatigueOrdinaryRotationPosition,
  isOrdinaryPriorityPosition,
} from "./position-rotation-policy";
import {
  comparePreviousWorkdayLoad,
  createPreviousWorkdayLoadFacts,
  previousWorkdayLoadForStaff,
} from "../shared/previous-workday-load";
import {
  comparePositionFrequency,
  consecutivePositionAssignments,
  createScheduleFrequencyFacts,
  positionFrequencyProfileForAssignment,
  type ScheduleFrequencyFacts,
} from "../statistics/schedule-frequency";
import { assignmentRule } from "../flights/schedule-position-rules";
import type { ScheduleRunFacts } from "../shared/schedule-run-facts";
import {
  isRotationLocked,
  rotationCandidateAssignments,
  type RotationStaffChange,
} from "./rotation-review-safety";
import type { SolverPort } from "../solver/solver-port";
import {
  assignmentWarningMessage,
  rotationCandidateWarningMessage,
  rotationWarningCandidates,
} from "./schedule-warning-message";
import { countedWorkloadAssignments } from "../shared/workload-accounting";

type RotationKind = "priority" | "high-fatigue" | "ordinary";

function rotationKind(
  state: ScheduleGenerationFacts,
  assignment: Assignment
): RotationKind {
  const rule = assignmentRule(state, assignment)!;
  if (
    isOrdinaryPriorityPosition(rule, state.settings.ordinaryPriorityPositions)
  )
    return "priority";
  return isHighFatigueOrdinaryRotationPosition(
    rule,
    state.settings.highLoadFatigueThreshold,
    state.settings.ordinaryPriorityPositions
  )
    ? "high-fatigue"
    : "ordinary";
}

function rotationKindOrder(kind: RotationKind): number {
  if (kind === "priority") return 0;
  if (kind === "high-fatigue") return 1;
  return 2;
}

function targetStaffOrder(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  primary: Assignment,
  date: string,
  facts?: ScheduleRunFacts,
  frequencyFacts?: ScheduleFrequencyFacts
): (leftId: string, rightId: string) => number {
  const countedAssignments = countedWorkloadAssignments(state, assignments);
  const previousLoadFacts =
    facts?.previousWorkdayLoad ?? createPreviousWorkdayLoadFacts(state, date);
  const loadByStaffId = new Map(
    state.staff.map((person) => {
      const ownAssignments = countedAssignments.filter(
        (assignment) => assignment.staffId === person.id
      );
      return [
        person.id,
        {
          historyFatigue: historyFatigue(
            state.history,
            person.id,
            date,
            state.settings
          ),
          todayWorkHours: ownAssignments.reduce(
            (sum, assignment) => sum + assignment.workHours,
            0
          ),
          todayFatigue:
            ownAssignments.reduce(
              (sum, assignment) => sum + assignment.fatiguePoints,
              0
            ) +
            (facts?.currentDutyStaffId === person.id
              ? state.settings.dutyFatiguePoints
              : 0),
        },
      ] as const;
    })
  );
  return (leftId, rightId) => {
    const leftLoad = loadByStaffId.get(leftId)!;
    const rightLoad = loadByStaffId.get(rightId)!;
    const frequencyDifference = comparePositionFrequency(
      positionFrequencyProfileForAssignment(
        state,
        primary,
        leftId,
        date,
        frequencyFacts
      ),
      positionFrequencyProfileForAssignment(
        state,
        primary,
        rightId,
        date,
        frequencyFacts
      )
    );
    const previousLoadDifference = comparePreviousWorkdayLoad(
      previousWorkdayLoadForStaff(previousLoadFacts, leftId),
      previousWorkdayLoadForStaff(previousLoadFacts, rightId)
    );
    const priority = assignmentRule(state, primary);
    return (
      (priority &&
      isOrdinaryPriorityPosition(
        priority,
        state.settings.ordinaryPriorityPositions
      )
        ? frequencyDifference || previousLoadDifference
        : previousLoadDifference || frequencyDifference) ||
      leftLoad.historyFatigue - rightLoad.historyFatigue ||
      leftLoad.todayWorkHours - rightLoad.todayWorkHours ||
      leftLoad.todayFatigue - rightLoad.todayFatigue ||
      state.staff.findIndex((person) => person.id === leftId) -
        state.staff.findIndex((person) => person.id === rightId) ||
      leftId.localeCompare(rightId, undefined, { numeric: true })
    );
  };
}

function applyRotationPlan(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  primary: Assignment,
  changes: readonly RotationStaffChange[],
  runs: number,
  fatigueRelief: boolean,
  protectedReplacementFallback: boolean
): string | undefined {
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
  applyConfiguredEarlyReleases(
    assignments,
    state,
    new Set(
      changedAssignments.flatMap((item) => (item.staffId ? [item.staffId] : []))
    )
  );
  const participants = new Set(
    changes.flatMap((change) => [
      originalById.get(change.assignmentId)!.staffId,
      change.staffId,
    ])
  ).size;
  const route = changes
    .map((change) => {
      const assignment = assignments.find(
        (item) => item.id === change.assignmentId
      )!;
      return `${assignment.staffName}接${assignment.flightNo}/${assignment.position}`;
    })
    .join(" → ");
  const originalPrimary = originalById.get(primary.id)!;
  const reliefAssignment = changedAssignments.find(
    (assignment) => assignment.staffId === originalPrimary.staffId
  );
  const message =
    fatigueRelief && reliefAssignment
      ? `${originalPrimary.staffName}已连续${runs === 1 ? "一" : "两"}个工作班承担${originalPrimary.flightNo}/${originalPrimary.position}，无法彻底退出晚班时，本班通过${participants}人整体重排换到${reliefAssignment.flightNo}/${reliefAssignment.position}的${reliefAssignment.fatiguePoints}点普通岗位；跨工作日恢复和次班截止仅对这次明确降疲劳改善让步，其余安全约束与岗位完整性验证通过。`
      : `${originalPrimary.staffName}已连续${runs === 1 ? "一" : "两"}个工作班承担${originalPrimary.flightNo}/${originalPrimary.position}，本班已通过${participants}人整体重排解除：${route}；岗位完整性及全部安全约束验证通过。`;
  const recoveryFallbackMessage = protectedReplacementFallback
    ? assignmentWarningMessage({
        staffName: primary.staffName,
        fact: `属于上一班末班重点岗位人员，本班仍接替${primary.flightNo}/${primary.position}`,
        reasons: ["其他不移动受保护人员的安全方案均已穷尽"],
        result: "保留本次调整，请复核恢复情况",
      })
    : undefined;
  changedAssignments.forEach((assignment) => {
    rebuildAutomaticAssignmentEvidence(assignment, [
      schedulingDecision("position-rotation", "selected", message),
      ...(recoveryFallbackMessage
        ? [
            schedulingDecision(
              "late-shift-recovery",
              "fallback",
              recoveryFallbackMessage
            ),
          ]
        : []),
    ]);
  });
  return recoveryFallbackMessage;
}

function unresolvedMessage(
  primary: Assignment,
  runs: number,
  _kind: RotationKind,
  attemptedReasons: readonly string[]
): string {
  return assignmentWarningMessage({
    staffName: primary.staffName,
    fact: `已连续${runs}次承担${primary.flightNo}/${primary.position}`,
    reasons: attemptedReasons,
    result: `保留原安排，当前连续第${runs + 1}次`,
  });
}

export async function reviewConsecutivePositionRotation(
  solver: SolverPort,
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  date: string,
  lockedAssignmentIds: ReadonlySet<string>,
  facts?: ScheduleRunFacts
): Promise<string[]> {
  if (!state.settings.positionRotationEnabled) return [];
  const frequencyFacts =
    facts?.scheduleFrequency ?? createScheduleFrequencyFacts(state, date);
  const mobileReview = await reviewMobileSupervisorGroupRotation(
    solver,
    state,
    assignments,
    date,
    lockedAssignmentIds,
    facts,
    "consecutive"
  );
  const reviewed = new Set(mobileReview.reviewedAssignmentIds);
  const warnings: string[] = [...mobileReview.warnings];
  const primaryAssignments = assignments
    .filter(
      (assignment) => !isRotationLocked(state, assignment, lockedAssignmentIds)
    )
    .map((assignment) => ({
      assignment,
      kind: rotationKind(state, assignment),
      runs: consecutivePositionAssignments(
        state,
        assignment.staffId!,
        assignment.flightNo,
        assignment.position,
        assignment.remark,
        date,
        frequencyFacts
      ),
    }))
    .filter((item) =>
      item.kind === "ordinary" ? item.runs >= 2 : item.runs > 0
    )
    .sort(
      (left, right) =>
        rotationKindOrder(left.kind) - rotationKindOrder(right.kind) ||
        right.runs - left.runs ||
        right.assignment.fatiguePoints - left.assignment.fatiguePoints ||
        left.assignment.flightNo.localeCompare(right.assignment.flightNo) ||
        left.assignment.position.localeCompare(right.assignment.position)
    );

  for (const { assignment: primary, runs, kind } of primaryAssignments) {
    if (reviewed.has(primary.id)) continue;
    const compareStaff = targetStaffOrder(
      state,
      assignments,
      primary,
      date,
      facts,
      frequencyFacts
    );
    const availableAssignments = rotationCandidateAssignments(
      assignments,
      primary,
      state,
      lockedAssignmentIds
    )
      .filter((candidate) => !reviewed.has(candidate.id))
      .filter((candidate) => {
        const candidateKind = rotationKind(state, candidate);
        if (kind === "priority") return true;
        if (kind === "high-fatigue") return candidateKind !== "priority";
        return candidateKind === "ordinary";
      });
    const search = await findConsecutiveRotationPlan({
      solver,
      state,
      assignments,
      primary,
      availableAssignments,
      date,
      compareStaff,
      facts,
      frequencyFacts,
      timeoutMs:
        assignments.length > 30 || state.history.length > 1_000
          ? 250
          : undefined,
    });
    if (search.plan) {
      const fallback = applyRotationPlan(
        state,
        assignments,
        primary,
        search.plan.changes,
        runs,
        search.plan.fatigueRelief,
        search.plan.protectedReplacementFallback
      );
      search.plan.changes.forEach((change) =>
        reviewed.add(change.assignmentId)
      );
      if (fallback) warnings.push(fallback);
      continue;
    }
    reviewed.add(primary.id);
    const message = unresolvedMessage(
      primary,
      runs,
      kind,
      search.attemptedReasons
    );
    const warningMessage =
      search.candidateRejections && kind === "priority"
        ? rotationCandidateWarningMessage({
            staffName: primary.staffName,
            fact: `已连续${runs}次承担${primary.flightNo}/${primary.position}`,
            targetFlightNo: primary.flightNo,
            candidates: rotationWarningCandidates(
              state,
              primary,
              date,
              search.candidateRejections,
              facts
            ),
            timedOut: search.termination !== "infeasible",
          })
        : message;
    replaceAssignmentDecisions(primary, "position-rotation", [
      schedulingDecision("position-rotation", "fallback", warningMessage),
    ]);
    warnings.push(warningMessage);
  }
  return warnings;
}
