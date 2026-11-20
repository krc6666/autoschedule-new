import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import { consecutivePositionAssignments } from "../statistics/schedule-frequency";
import { assignmentRule } from "../flights/schedule-position-rules";
import {
  isKe166MobileSupervisor,
  isMobileSupervisor,
} from "../flights/schedule-tasks";
import { schedulingDecision } from "../rules/schedule-rule-contract";
import { isOrdinaryPriorityPosition } from "./position-rotation-policy";
import {
  appendAssignmentDecision,
  replaceAssignmentDecisions,
} from "../assignments/assignment-evidence";
import { assignmentWarningMessage } from "./schedule-warning-message";

function clearPositionRotationDecisions(assignment: Assignment): void {
  replaceAssignmentDecisions(assignment, "position-rotation", []);
}

export function refreshPositionRotationEvidence(
  state: ScheduleGenerationFacts,
  date: string | null
): void {
  state.assignments.forEach(clearPositionRotationDecisions);
  if (!date || !state.settings.positionRotationEnabled) return;

  for (const assignment of state.assignments) {
    const rule = assignmentRule(state, assignment);
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    if (
      rule &&
      flight &&
      !rule.manual &&
      (isKe166MobileSupervisor(flight, rule, state) ||
        (isMobileSupervisor(flight, rule) &&
          isOrdinaryPriorityPosition(
            rule,
            state.settings.ordinaryPriorityPositions
          ))) &&
      assignment.status === "assigned" &&
      assignment.staffId
    ) {
      const previousRuns = consecutivePositionAssignments(
        state,
        assignment.staffId,
        assignment.flightNo,
        assignment.position,
        assignment.remark,
        date
      );
      if (previousRuns >= 1) {
        const linkedAssignments = state.assignments.filter(
          (item) => item.supervisorSourceAssignmentId === assignment.id
        );
        const message = assignmentWarningMessage({
          staffName: assignment.staffName,
          fact: `已连续${previousRuns}次承担${assignment.flightNo}/${assignment.position}`,
          reasons: [
            `人工调整后仍连续承担${linkedAssignments.length ? "机动督导及兼任柜台" : "机动督导"}`,
          ],
          decision: "尊重人工安排",
          result: `保留当前第${previousRuns + 1}次连续安排，请复核`,
          attempt: "当前为人工安排，系统不会自动换人",
        });
        for (const target of [assignment, ...linkedAssignments]) {
          appendAssignmentDecision(
            target,
            schedulingDecision("position-rotation", "fallback", message)
          );
        }
      }
      continue;
    }
    if (
      !rule ||
      (rule.category !== "常规" &&
        !isOrdinaryPriorityPosition(
          rule,
          state.settings.ordinaryPriorityPositions
        )) ||
      rule.manual ||
      assignment.supervisorSourceAssignmentId !== undefined ||
      assignment.status !== "assigned" ||
      !assignment.staffId
    )
      continue;
    const priority = isOrdinaryPriorityPosition(
      { ...rule, flightNo: assignment.flightNo },
      state.settings.ordinaryPriorityPositions
    );
    const previousRuns = consecutivePositionAssignments(
      state,
      assignment.staffId,
      assignment.flightNo,
      assignment.position,
      assignment.remark,
      date
    );
    if (priority ? previousRuns < 1 : previousRuns < 2) continue;
    const message = assignmentWarningMessage({
      staffName: assignment.staffName,
      fact: `已连续${previousRuns}次承担${assignment.flightNo}/${assignment.position}`,
      reasons: ["人工调整后仍连续承担该岗位"],
      decision: "尊重人工安排",
      result: `保留当前第${previousRuns + 1}次连续安排，请复核`,
      attempt: "当前为人工安排，系统不会自动换人",
    });
    appendAssignmentDecision(
      assignment,
      schedulingDecision("position-rotation", "fallback", message)
    );
  }
}
