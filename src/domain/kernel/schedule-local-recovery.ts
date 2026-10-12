import type { Assignment } from "../../model";
import type { ScheduleGenerationFacts } from "../shared/scheduling-facts";
import {
  assignmentRule,
  guideSourceStaff,
  isGuideAssignment,
  makeUnfilled,
} from "../flights/schedule-position-rules";
import { guardExplanation } from "../shared/schedule-issue-explanation";
import { ScheduleGuardError } from "./schedule-guard";

/** Only automatic generation consumes this recovery. Checks remain strict. */
export function recoverLocalScheduleIssues(
  state: ScheduleGenerationFacts,
  assignments: Assignment[],
  check: (assignments: readonly Assignment[]) => void
): string[] {
  const warnings: string[] = [];
  const clear = (assignment: Assignment, reason: string): void => {
    const rule = assignmentRule(state, assignment);
    const flight = state.flights.find(
      (item) => item.id === assignment.flightId
    );
    if (!flight || !rule || assignment.status === "manual")
      throw new Error("无法确认问题岗位的配置，未采用新班表");
    const name = assignment.staffName;
    const blank = {
      ...makeUnfilled(flight, rule.name, rule),
      id: assignment.id,
      status: "unfilled" as const,
      systemNotes: [
        `${name ? `原安排${name}。` : ""}${reason}这个岗位已留空，其他合法安排保留。请按实际情况核对人员状态和岗位设置；信息正确时请开发人员检查。`,
      ],
    };
    if (rule.category === "引导") {
      blank.workHours = 0;
      blank.fatiguePoints = 0;
    }
    // Replace the complete record so stale decisions and zero-hour fill links
    // cannot survive a vacancy. Keep the row ID for UI/export references.
    const index = assignments.findIndex((item) => item.id === assignment.id);
    assignments[index] = blank;
    warnings.push(
      `${blank.flightNo}/${blank.position}：${blank.systemNotes[0]}`
    );
  };

  // Each pass removes at least one assigned row. Never retry indefinitely.
  for (let pass = 0; pass <= assignments.length; pass += 1) {
    try {
      check(assignments);
      return warnings;
    } catch (error) {
      if (!(error instanceof ScheduleGuardError)) throw error;
      const violation = error.violations.find((item) => {
        const target = assignments.find((row) => row.id === item.assignmentId);
        return target && target.status === "assigned" && target.staffId;
      });
      const target = assignments.find(
        (row) => row.id === violation?.assignmentId
      );
      if (!violation || !target) throw error;
      clear(target, guardExplanation(violation));
      // A removed source cannot leave a zero-hour counter or borrowed guide.
      for (const row of [...assignments]) {
        if (row.status !== "assigned" || !row.staffId) continue;
        if (row.supervisorSourceAssignmentId === target.id) {
          clear(
            row,
            "原来补位的督导岗位已留空，柜台不能继续沿用这份补位安排。"
          );
        } else if (
          isGuideAssignment(state, row) &&
          !assignments.some(
            (source) =>
              source.flightId === row.flightId &&
              guideSourceStaff(state, source)?.id === row.staffId
          )
        ) {
          clear(row, "原来借用的常规岗位已留空，引导岗位也需要重新补人。");
        }
      }
    }
  }
  throw new Error("局部岗位检查未能完成，未采用新班表");
}
